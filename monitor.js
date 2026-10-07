require("dotenv").config();

const axios = require("axios");

const {
    TelegramClient
} = require("telegram");

const {
    StringSession
} = require("telegram/sessions");

const {
    NewMessage
} = require("telegram/events");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

const session = new StringSession(
    process.env.TELEGRAM_SESSION
);

const WEBHOOK_URL = process.env.WEBHOOK_URL;

const client = new TelegramClient(
    session,
    apiId,
    apiHash,
    {
        connectionRetries: 10
    }
);

(async () => {

    console.log("Connecting to Telegram...");

    await client.connect();

    console.log("Telegram connected.");

    const channel = await client.getEntity("ipo_Alarm");

    console.log(
        `Monitoring channel: ${channel.title}`
    );

    client.addEventHandler(
        async (event) => {

            try {

                const message = event.message;

                console.log("\n==============================");
                console.log("NEW MESSAGE");
                console.log("==============================");

                console.log("Message ID:", message.id);
                console.log("Text:", message.text);

                const payload = {
                    source: "telegram",

                    channel: {
                        username: channel.username,
                        title: channel.title,
                        id: channel.id?.toString()
                    },

                    message: {
                        id: message.id,

                        text: message.text || "",

                        date: message.date,

                        hasMedia: !!message.media
                    }
                };

                console.log(
                    "Sending webhook..."
                );

                await axios.post(
                    WEBHOOK_URL,
                    payload,
                    {
                        timeout: 15000
                    }
                );

                console.log(
                    "Webhook delivered successfully."
                );

            } catch (error) {

                console.error(
                    "Webhook error:",
                    error.message
                );

            }

        },

        new NewMessage({
            chats: ["ipo_Alarm"]
        })
    );

    console.log(
        "Waiting for new IPO Alarm posts..."
    );

})();