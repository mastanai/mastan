# Mastan

**Your own AI assistant that lives in your chats.** You write to it on Telegram or WhatsApp, like you write to a person. It answers, remembers what you told it, makes PowerPoint, Excel and Word files for you, checks facts with sources, opens web pages, and reminds you on time.

This is the real code behind [mastan.ai](https://mastan.ai). It is free. Take it, run it, change it.

## Install in one line

On a fresh Ubuntu server (24.04 or newer), paste this and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/mastanai/mastan/main/install.sh | sudo bash
```

**Do not use the green Code button** on this page, and do not copy the `.git` address. That only downloads the code. The line above installs everything.

New to servers? Read on, the steps below explain each part.

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

## What it can do out of the box

Tested on a fresh install, by chat:

- **Presentations.** "Make me a 5-slide deck about the history of coffee." An editable PowerPoint arrives in the chat in about 2 to 3 minutes. Mastan renders every slide and looks at it before sending.
- **Spreadsheets.** "Make me a household budget in Excel with formulas." A workbook with working formulas, checked for errors, in about 4 minutes.
- **Word documents.** "Write a letter to my landlord about the heating." A one-page .docx in under a minute, with blanks instead of made-up names.
- **Reminders.** "Remind me in 3 minutes to stretch." It arrives on time.
- **Fact checks.** "Is the Great Wall visible from space?" A verdict first, then the evidence with sources, in under a minute.
- **Shopping research.** "Where can I buy a Kindle in Germany and for how much?" Live prices with links to the pages it read.
- **Web pages.** "Open this page and send me a screenshot." It opens the page in its own browser and sends the picture.

All of this was tested through Telegram. On WhatsApp, background tasks and reminders do not work yet (see "Adding the other app later").

## What you need

1. **A server.** A small Linux server from any provider. About 5 euros a month is enough.
2. **An AI subscription of your own.** A Claude subscription. Mastan uses your subscription to think. Without it, Mastan has no brain. A ChatGPT subscription is optional: with it, Mastan hands coding jobs to Codex.
3. **WhatsApp or Telegram** on your phone. This is where you will talk to your Mastan. For WhatsApp, Mastan needs a second WhatsApp number of its own.

You pay for the server and the subscription yourself, in two different places. Mastan itself costs nothing.

Pick **Ubuntu 24.04 or newer** when you rent the server. 4 GB of memory is enough. The install uses about 4 GB of disk, most of it for the document tools and the browser.

## Before you start: WhatsApp or Telegram?

The installer's first question is:

```
==> Where do you want to talk to your Mastan?

      1  WhatsApp
      2  Telegram

    Type 1 or 2 and press Enter:
```

**For WhatsApp (1):** Mastan needs **its own WhatsApp number**, a second one. You write to it from your normal number. A spare SIM works. So does the free WhatsApp Business app on your phone with a second number. Have that phone next to you.

**For Telegram (2):** make your bot first, on your phone:

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot` and follow the questions. Pick any name you like.
3. BotFather gives you a long code called a **token**. Keep it. It is the key to your bot, so do not share it.

## Step 1: Install Mastan

Log in to your server. Copy this one line, paste it and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/mastanai/mastan/main/install.sh | sudo bash
```

Type **1** for WhatsApp or **2** for Telegram.

- **WhatsApp:** it asks for your normal WhatsApp number with the country code. The install then runs for about three minutes. At the end it shows a square code. On the phone with Mastan's number, open WhatsApp, go to **Settings > Linked devices > Link a device**, and scan it, the same as logging in to WhatsApp Web. When it says "Linked", go to step 2.
- **Telegram:** paste the token (it stays hidden). The install then runs for about three minutes. At the end it says "Open your new bot @yourbot in Telegram, press Start, and send it this code:" with a 6-digit code. Do that. When it says "Linked to" and your name, your bot answers only you. Go to step 2.

Running it again is safe. It updates Mastan, keeps your settings and does not ask again.

No server yet and you only want to look? Press the green **Code** button at the top of this page, then **Download ZIP**.

## Step 2: Connect your AI subscription

Paste this and press Enter:

```sh
sudo mastan-login claude
```

It shows a link. Open it on your phone or laptop, sign in with your own Claude account, and paste the code it gives you back into the server.

Have ChatGPT too? Paste this as well:

```sh
sudo mastan-login codex
```

It shows a link and a short code. Open the link, sign in with your ChatGPT account and type the code.

## Step 3: Say hello

**WhatsApp:** from your normal number, write hello to Mastan's number. Mastan never writes first, so the first message comes from you.

**Telegram:** open your bot and say hello.

If it stays quiet, this shows what Mastan is doing:

```sh
sudo journalctl -u mastan-me -f
```

## Adding the other app later

You can have both WhatsApp and Telegram. Add the second one any time:

- WhatsApp, or linking again: `sudo mastan-login whatsapp`
- Telegram: `sudo mastan-login telegram`

What works on WhatsApp today: chatting and reading files you send it. Files Mastan makes are not tested on WhatsApp yet. Not yet on WhatsApp: background tasks and schedules ("remind me at 9"). For those, use Telegram.

## Honest notes

- **This guide is new.** The installer has been tested from zero on empty Ubuntu 24.04 and 26.04 servers, including a restart and a reboot. Telegram setup and the Claude sign-in have been done by a person on a fresh server. WhatsApp linking and the ChatGPT sign-in are still being tested. If a step fails for you, [open an issue](https://github.com/mastanai/mastan/issues) and tell us where.
- **Schedules use Riyadh time for now.** "Remind me at 9" means 9:00 in Riyadh. A setting for your own time zone is planned.
- **Use your own subscription only for yourself.** A personal AI subscription is for your own use, not for serving other people. If others will talk to your Mastan, read the API-key section in the developer notes.
- **Your data stays on your server.** This repository contains no keys, no user data and no server addresses.
- Email, the web chat with passkey login and the other parts are optional. Start with WhatsApp or Telegram.

## Too much?

That is a fair reaction. Renting a server, paying in two places and keeping it all running is real work.

Open [mastan.ai](https://mastan.ai) and ask for a private Mastan. You get the same thing, set up for you.

## For developers

How it works inside, the folder map, model settings and every switch: [docs/DEVELOPERS.md](docs/DEVELOPERS.md).

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).

If Mastan is useful to you, a star on this page helps other people find it.
