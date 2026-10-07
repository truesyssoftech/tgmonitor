require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

const stringSession = new StringSession("");

const client = new TelegramClient(
    stringSession,
    apiId,
    apiHash,
    {
        connectionRetries: 5
    }
);

(async () => {

    console.log("Connecting to Telegram...");

    await client.start({
        phoneNumber: async () =>
            await input.text("Enter your Telegram phone number: "),

        password: async () =>
            await input.text("Enter your 2FA password: "),

        phoneCode: async () =>
            await input.text("Enter Telegram verification code: "),

        onError: (err) =>
            console.log(err)
    });

    console.log("\nSuccessfully logged in!");

    console.log("\nSESSION STRING:");
    console.log(client.session.save());

    await client.disconnect();

})();