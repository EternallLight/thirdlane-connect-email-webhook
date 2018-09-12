#!/usr/bin/env node

/**
 * Thirdlane Connect Email Webhook
 *
 * Get notifications in Thirdlane Connect for received and sent mail.
 * Written in ES2015 and with async/await from ES2017.
 *
 * Nick Schwarzenberg
 * nick@bitfasching.de
 * v0.1.2, 04/2017
 *
 * License: AGPLv3
 */

'use strict';


// external module dependencies
const console = require('timestamped-console')('yyyy-mm-dd HH:MM');
const ImapClient = require('emailjs-imap-client');
const Envelope = require('envelope');

const htmlToText = require('html-to-text');
const _ = require('lodash');

const fs = require('fs');
const promisify = require('util').promisify;
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

// built-in module dependencies
const HTTPS = require('https');
const URL = require('url');

const htmlToTextOptionsDefault = {
    wordwrap: false,
    preserveNewlines: true,
    singleNewLineParagraphs: true,
};

// load configuration, optionally from path set as environment variable
const configs = require(process.env.CONFIG || './config.js');

if (!_.isArray(configs) || !configs.length) {
    throw new Error('Config must be passed in form of non-empty array.');
}

configs.forEach((c) => {
    // Parse webhook URL only once
    c.webhookURL = URL.parse(c.webhookURL);
    // Update html-to-text config.
    if (c.htmlToTextOptions) {
        c.htmlToTextOptions = Object.assign({}, htmlToTextOptionsDefault, c.htmlToTextOptions);
    }
});

// mention in the log when process exits
process.on('exit', () => console.log('Exiting…'));

// main logic
async function main() {
    configs.forEach(async (config) => {
        // tell what's happening
        console.log('Connecting to %s:%d…', config.host, config.port);

        // connect to server
        const client = await connect(config);

        // listen for fatal errors
        client.onerror = (error) => {
            // log fatal error and exit
            console.error('Fatal IMAP client error!');
            console.error(error);
            process.exit();
        };

        // listen for process kill events
        process.on('SIGINT', () => {
            // …and logout before exiting
            console.log('SIGINT, logging out…');
            client.logout();
            process.exit();
        });

        // get available mailboxes
        const availableMailboxes = await listMailboxes(client);

        // wanted mailbox not available?
        if (!availableMailboxes.includes(config.mailbox)) {
            // fail with error, but list available mailboxes for convenience
            console.error('Wanted mailbox "%s" is not available.', config.mailbox);
            console.log('Available mailboxes: %s', availableMailboxes.map((name) => `"${name}"`).join(', '));
            process.exit();
        }

        // get initial number of mails
        let cachedMailCount = await queryMailbox(client, config);

        // show mailbox size
        console.log('Selected mailbox "%s" containing %s mail(s).', config.mailbox, cachedMailCount !== undefined ? cachedMailCount : '?');

        // fetch all unread mails?
        if (config.fetchUnread) {
            // get sequence numbers of unread mails
            const unreadMails = await client.search(config.mailbox, {unseen: true});

            // any unread mails?
            if (unreadMails && unreadMails.length > 0) {
                // tell what's happening
                console.log('Fetching %d unread mail(s)…', unreadMails.length);

                // fetch unread mails
                await fetchMails(client, unreadMails, config);
            } else {
                // also tell what's not happening
                console.log('No unread mails to fetch.');
            }
        }

        // stay updated
        client.onupdate = async (path, type, value) => {
            // ignore if wrong path
            if (path !== config.mailbox) return;

            // mail deleted?
            if (type === 'expunge') {
                // decrease cached mail count
                cachedMailCount--;
            }

            // new mails?
            if (type === 'exists' && value > cachedMailCount) {
                // get new mail count
                const currentMailCount = value;

                // create array of sequence numbers to fetch
                let newMails = getRange(cachedMailCount + 1, currentMailCount);

                // tell what's happening
                console.log('Fetching %d new mail(s)…', newMails.length);

                // fetch new mails
                await fetchMails(client, newMails, config);

                // update cached mail count
                cachedMailCount = currentMailCount;
            }
        };
    });
}


// connect to IMAP server
async function connect(config) {
    // create new ImapClient instance
    const client = new ImapClient(config.host, config.port, {
        auth: {
            user: config.username,
            pass: config.password,
        },
        requireTLS: config.requireTLS,
    });

    // disable internal logging
    client.logLevel = client.LOG_LEVEL_NONE;

    try {
        // open connection to server
        await client.connect();
        return client;
    } catch (error) {
        // fail with error
        console.error('Could not connect to %s:%d!', config.host, config.port);
        console.error(error);
        process.exit();
    }
}


// get list of available mailbox paths
async function listMailboxes(client) {
    try {
        // try to list mailboxes
        const list = await client.listMailboxes();

        // pattern for matching path specifications
        const pathPattern = '"path":\s*"([^"]+)"';

        // flatten nested object the dirty way and find mentioned paths
        const pathMatches = JSON.stringify(list).match(new RegExp(pathPattern, 'g'));

        // extract paths from matches
        const paths = pathMatches.map((match) => match.replace(new RegExp(pathPattern), '$1'));

        // try to get paths from available mailboxes
        return paths;
    } catch (error) {
        // fail with error
        console.error('Could not list mailboxes!');
        console.error(error);
        process.exit();
    }
}


// get number of existing mails in the mailbox
async function queryMailbox(client, config) {
    try {
        // try to get mailbox status
        const status = await client.selectMailbox(config.mailbox);

        // return number of existing mails
        return Number(status.exists);
    } catch (error) {
        // fail with error
        console.error('Could not query mailbox status of "%s"!', config.mailbox);
        console.error(error);
        process.exit();
    }
}


// fetch mails by sequence numbers
async function fetchMails(client, ids, config) {
    // notifications to send to Thirdlane Connect
    let notifications = [];

    // Removing emails that were already notified with Webhook.
    ids = await filterNotifierIds(ids, config);

    // for each sequence number…
    for (let id of ids) {
        // try to fetch the mail and turn it into a Thirdlane Connect notification
        const notification = await mailToNotification(client, id, config);

        // add to list of new notifications if successful
        notification && notifications.push(notification);
    }

    // send notifications to Thirdlane Connect if any
    sendToThirdlaneConnect(notifications, config).then(async () => {
        if (ids.length) {
            await saveNotified(ids, config);
            console.log(`The emails with following IDs were notified via webhook: ${ids.join(', ')}`);
        } else {
            console.log(`All new emails were already notified via Webhook. No notifications have been sent.`);
        }
    });
}

/**
 * Removes ids that were already notified via a webhook.
 *
 * @param {Number[]} ids
 * @param {Object} config
 * @return {Promise<Number[]>}
 */
async function filterNotifierIds(ids, config) {
    const filePath = `${__dirname}/history/${config.username}.json`;
    let notified = await readFile(filePath, {encoding: 'utf8', flag: 'a+'});
    notified = notified ? JSON.parse(notified) : {ids: []};
    return ids.filter((id) => !notified.ids.includes(id));
}

/**
 * Adds the given ids to the notified list in json file.
 *
 * @param {Number[]} ids
 * @param {Object} config
 * @return {Promise<void>}
 */
async function saveNotified(ids, config) {
    const filePath = `${__dirname}/history/${config.username}.json`;
    let notified = await readFile(filePath, {encoding: 'utf8', flag: 'a+'});
    notified = notified ? JSON.parse(notified) : {ids: []};
    notified.ids = notified.ids.concat(ids);
    return writeFile(`${__dirname}/history/${config.username}.json`, JSON.stringify(notified, null, 4));
}

// fetch mail by its sequence number, parse and turn into a Thirdlane Connect notification
async function mailToNotification(client, id, config) {
    // processed header, unprocessed body
    let header = {};
    let rawBody = '';

    try {
        // try to fetch header and content from server
        const messageItems = await client.listMessages(config.mailbox, id, ['envelope', `${config.keepUnread ? 'body.peek[]' : 'body[]'}<0.${config.sizeLimit}>`]);
        header = messageItems[0]['envelope'];
        rawBody = messageItems[0]['body[]'];
    } catch (error) {
        // log error and return
        console.error('Could not fetch mail #%d!', id);
        console.error(error);
        return;
    }

    // plaintext content
    let content = '';

    try {
        // try to parse MIME tree of contents
        const contentTree = new Envelope(rawBody);

        // try to find plaintext content
        content = findTextContent(contentTree, config.htmlToTextOptions);
    } catch (error) {
        // log error, but move on
        console.error('Could not parse content of mail #%d.', id);
        console.error(error);

        content = '_Content of this email could not be parsed_';
    }

    let fields = [];
    fields.push({title: 'From', value: emailsToString(header.from)});
    fields.push({title: 'To', value: emailsToString(header.to)});
    if (config.showCopy) {
        if (header.cc) {
            fields.push({title: 'CC', value: emailsToString(header.cc)});
        }
        if (header.bcc) {
            fields.push({title: 'BCC', value: emailsToString(header.bcc)});
        }
    }

    content = content || '_No message text available._';

    // create Thirdlane Connect notification with common content
    return {
        text: `New message in *${config.username}*!`,
        attachments: [{
            title: header.subject,
            fields,
            text: content,
        }],
    };
}


// assume most common MIME tree to recursively find plaintext in a multipart mail parsed by envelope
function findTextContent(parts, htmlToTextOptions) {
    if (parts.header && parts.header.contentType) { // check if passed parts object contains desired plaintext content
        switch (parts.header.contentType.mime) {
            case 'text/html':
                return htmlToText.fromString(parts[0], htmlToTextOptions);
            case 'text/plain':
                return parts[0];
            default:
                return findTextContent(parts['0'], htmlToTextOptions);
        }
    } else if (parts['0'] && parts['0'].header) { // more levels to check?
        // recurse to deeper level
        return findTextContent(parts['0'], htmlToTextOptions);
    }

    // nothing found
    else {
        // create error, but remove Stack trace
        const flatError = new Error('Could not find text/plain content in MIME tree.');
        delete flatError.stack;

        // throw error
        throw flatError;
    }
}

// send an array of one or more notifications to a Thirdlane Connect webhook
function sendToThirdlaneConnect(notifications, config) {
    // return if no notifications to send
    if (notifications.length === 0) {
        return Promise.resolve();
    }

    let queue = [];
    notifications.forEach((notification) => {
        // create payload for POST request
        let payload = JSON.stringify(notification);

        // apply required entity encoding
        payload = payload.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;');

        // POST parameters for JSON webhook
        const postParameters = {
            method: 'POST',
            host: config.webhookURL.host,
            path: config.webhookURL.path,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const pr = new Promise((resolve, reject) => {
            // start request to Thirdlane Connect
            const request = HTTPS.request(postParameters, (response) => {
                // check status code
                if (response.statusCode === 200) {
                    // all good
                    console.log(`Sent a notification to Thirdlane Connect: ${payload}`);
                } else {
                    // log error, but don't do anything about it
                    console.error('Thirdlane Connect returned unexpected status code %d.', response.statusCode);
                }

                // resolve Promise regardless of possible errors
                resolve();
            });

            // send payload
            request.write(payload);
            request.end();
        });

        queue.push(pr);
    });
    return Promise.all(queue);
}

/**
 * Converts array of emails to string to display in Webhook.
 *
 * @param {{name: String, address: String}[]} emails
 * @return {String}
 */
function emailsToString(emails = []) {
    let output = [];
    emails.forEach((email) => {
        const str = email.name ? `${email.name} <${email.address}>` : email.address;
        output.push(str);
    });
    return output.join(', ');
}

// helper: return array of number range from start to end, both inclusive
function getRange(start, end) {
    return Array.from(
        {length: end - start + 1},
        (element, index) => index + start,
    );
}

// go!
main();
