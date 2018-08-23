module.exports = [
    {
        /* :: IMAP Account Credentials :: */

        // should be the same as your email address
        username: 'user@provider.net',

        // plaintext password (will be encrypted during transport by TLS)
        password: 'password',

        /* :: IMAP Server Connection :: */

        // IMAP server hostname
        // (usually at the subdomain imap.* of your provider)
        host: 'imap.provider.net',

        // IMAP over TLS uses port 993 as default
        port: 993,

        // if not connecting to a TLS port, force use of STARTTLS?
        requireTLS: true,

        /* :: Email Retrieval :: */

        // mailbox (folder) to watch
        // (will show available mailboxes if specified name not found)
        mailbox: 'INBOX',

        // fetch unread mails on startup?
        fetchUnread: true,

        // truncate fetched mail to this many bytes
        // (may fail to extract content for large messages, but helps to avoid DoS)
        sizeLimit: 10 * 1024,

        /* :: Thirdlane Connect :: */
        webhookURL: 'https://connect.thirdlane.com/integration/webhooks/fddde9...',

        // show Cc: and Bcc: addresses in Thirdlane notifications?
        // (listed for sent mails together with receivers in To: field)
        showCopy: true,
    },
];
