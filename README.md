# Mastan

**Your own AI assistant that lives in your chats.** You write to it on Telegram, WhatsApp or a private web page, like you write to a person. It answers, remembers what you told it, makes files for you (presentations, spreadsheets, documents) and can do work on a schedule while you sleep.

This is the real code behind [mastan.ai](https://mastan.ai). It is free. Take it, run it, change it.

## Read this first

Mastan is **not an app for your laptop**. You cannot double-click it on Windows or on a Mac.

It runs on a small rented computer on the internet (a "server") that stays on day and night. That is why it can answer you at 3 a.m. and finish long jobs while your laptop is closed.

So there are two ways to get your own Mastan:

| | The easy way | The do-it-yourself way |
|---|---|---|
| What you do | Write to Mastan and ask for a private one | Follow the steps on this page |
| Time | A few minutes | An evening, if you are patient |
| You need to know | Nothing technical | How to copy and paste commands |
| Who fixes it when it breaks | We do | You do |

**The easy way:** open [mastan.ai](https://mastan.ai), start a chat and say "I want a private Mastan".

**The do-it-yourself way:** keep reading.

## What you need

1. **A server.** A small Linux server from any provider. About 5 euros a month is enough.
2. **An AI subscription of your own.** A Claude subscription. Mastan uses your subscription to think. Without it, Mastan has no brain.
3. **Telegram** on your phone. This is where you will talk to your Mastan.

You pay for the server and the subscription yourself, in two different places. Mastan itself costs nothing.

## Step 1: Download the code

On your server, copy this line, paste it and press Enter:

```sh
git clone https://github.com/mastanai/mastan.git /opt/mastan-me
```

No server yet and you only want to look? Press the green **Code** button at the top of this page, then **Download ZIP**.

## Step 2: Create your Telegram bot

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot` and follow the questions. Pick any name you like.
3. BotFather gives you a long code called a **token**. Keep it. It is the key to your bot, so do not share it.
4. Open a chat with **@userinfobot**. It tells you your **ID**, a number. Keep it too. It makes sure your Mastan answers only you.

## Step 3: Connect your AI subscription

The server needs two free tools first: **Node.js** version 26.5 or newer ([nodejs.org](https://nodejs.org)) and the **Claude Code** command-line tool ([Anthropic's guide](https://docs.claude.com/en/docs/claude-code/setup)). When both are installed, copy this:

```sh
claude login
```

It shows a link. Open it on your phone or laptop and sign in with your own Claude account.

## Step 4: Start Mastan

Copy this block. Replace the two `PASTE_...` parts with the token and the ID from step 2.

```sh
cd /opt/mastan-me
npm ci

export MASTAN_ME_DATA=/var/lib/mastan-me
export MASTAN_ME_HOSTNAME=localhost
export MASTAN_ME_RP_ID=localhost
export SESSION_SECRET=$(openssl rand -hex 32)
export AGENT_HOME=$HOME
export CLAUDE_BIN=$(command -v claude)
export TELEGRAM_BOT_TOKEN=PASTE_YOUR_TOKEN_HERE
export OWNER_TELEGRAM_ID=PASTE_YOUR_ID_HERE
export MASTAN_ME_MAIN_SANDBOX=off

bin/mastan-me-admin init-workspace
npm start
```

Now open your bot in Telegram and say hello.

## Honest notes

- **This guide is new.** The code runs every day on our own servers, but these exact steps have not yet been tested from zero on an empty server. A one-command installer and a video walkthrough are being prepared. If a step fails for you, [open an issue](https://github.com/mastanai/mastan/issues) and tell us where.
- **Use your own subscription only for yourself.** A personal AI subscription is for your own use, not for serving other people. If others will talk to your Mastan, read the API-key section in the developer notes.
- **Your data stays on your server.** This repository contains no keys, no user data and no server addresses.
- WhatsApp, email, the web chat with passkey login and the other parts are optional. Start with Telegram.

## Too much?

That is a fair reaction. Renting a server, paying in two places and keeping it all running is real work.

Open [mastan.ai](https://mastan.ai) and ask for a private Mastan. You get the same thing, set up for you.

## For developers

How it works inside, the folder map, model settings and every switch: [docs/DEVELOPERS.md](docs/DEVELOPERS.md).

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).

If Mastan is useful to you, a star on this page helps other people find it.
