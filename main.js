require("dotenv").config();
const config = require("./backend-config.json"); // Ensure config.base_url is set to "https://voice.google.com" and config.backendId is defined
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Supabase client
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(bodyParser.json());

let browser, page;

/**
 * Initialize Puppeteer using your desired settings.
 * We navigate to the default messages page for account index 0.
 */
async function initPuppeteer() {
  browser = await puppeteer.launch({
    headless: false,
    // Make sure your executablePath is correct
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: "./puppeteer_data",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled"
    ],
    defaultViewport: null,
  });
  page = await browser.newPage();
  // Hide the automation flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  // Always use config.base_url (e.g. "https://voice.google.com") for navigation.
  await page.goto(`${config.base_url}/u/0/messages`, { waitUntil: "networkidle2" });
  console.log("Puppeteer ready. Log in to Google Voice if needed.");
}

initPuppeteer().catch(console.error);

/**
 * Helper: Ensure that the Puppeteer page is available.
 */
function ensurePage(res) {
  if (!page || page.isClosed()) {
    res.status(500).send("Puppeteer page is not ready.");
    return false;
  }
  return true;
}

/**
 * /conversation-send endpoint:
 * Expects: text and account_index in the request body.
 * This endpoint assumes that the Puppeteer page is already in a conversation view.
 * It selects the message input, types the text, waits 1 second, and sends the message.
 */
app.post("/conversation-send", async (req, res) => {
  if (!ensurePage(res)) return;
  const { text, account_index } = req.body;
  if (!text) return res.status(400).send("text is required.");
  const accIndex = account_index !== undefined ? account_index : 0;
  try {
    const messageSelector = ".message-input-container textarea.message-input";
    await page.waitForSelector(messageSelector, { visible: true });
    // Clear the input box
    await page.click(messageSelector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    // Type the message
    await page.type(messageSelector, text);
    // Wait for 1 second
    await new Promise((r) => setTimeout(r, 1000));
    await page.focus(messageSelector);
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 2000));
    res.send(`Message sent in conversation using account index ${accIndex}.`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * /conversation endpoint:
 * Returns conversation messages for a given conversation.
 * When the "itemId" query parameter is provided, it navigates directly to:
 *   [config.base_url]/u/[account_index]/messages?itemId=[itemId]
 * The frontend should supply an itemId in the format: "t.%2B{number}"
 */
app.get("/conversation", async (req, res) => {
  if (!ensurePage(res)) return;
  const account_index = req.query.account_index ? Number(req.query.account_index) : 0;
  
  if (req.query.itemId) {
    const itemId = req.query.itemId;
    try {
      await page.goto(`${config.base_url}/u/${account_index}/messages?itemId=${itemId}`, { waitUntil: "networkidle2" });
      await page.waitForSelector("section .messages-container ul.list li gv-text-message-item", { visible: true });
      const messages = await page.evaluate(() => {
        const sel = "section .messages-container ul.list li gv-text-message-item .full-container";
        const els = document.querySelectorAll(sel);
        const result = [];
        els.forEach((el) => {
          const classes = el.className;
          const isOut = classes.includes("outgoing");
          const isIn = classes.includes("incoming");
          const textEl = el.querySelector(".content");
          const text = textEl ? textEl.textContent.trim() : "";
          let time = "";
          const statusEl = el.querySelector(".status");
          if (statusEl) {
            const st = statusEl.querySelector(".sender-timestamp .timestamp");
            time = st ? st.textContent.trim() : statusEl.textContent.trim();
          }
          result.push({
            from: isOut ? "You" : "Contact",
            text,
            time,
            direction: isOut ? "outgoing" : isIn ? "incoming" : "",
          });
        });
        return result;
      });
      res.json(messages);
      // Removed the delayed inbox update here to prevent navigating away from the conversation view.
    } catch (err) {
      return res.status(500).send(err.message);
    }
  } else {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Missing 'phone' query param." });
    try {
      await page.waitForSelector("ol.list", { visible: true });
      const clicked = await page.evaluate((p) => {
        const lis = Array.from(document.querySelectorAll("li.list-item"));
        for (const li of lis) {
          const phoneEl = li.querySelector(".title .participants");
          if (phoneEl && phoneEl.textContent.trim() === p) {
            const container = li.querySelector(".container");
            if (container) container.click();
            return true;
          }
        }
        return false;
      }, phone);
      if (!clicked) {
        return res.status(404).json({ error: `No conversation for: ${phone}` });
      }
      await page.waitForSelector("section .messages-container ul.list li gv-text-message-item", { visible: true });
      const messages = await page.evaluate(() => {
        const sel = "section .messages-container ul.list li gv-text-message-item .full-container";
        const els = document.querySelectorAll(sel);
        const result = [];
        els.forEach((el) => {
          const classes = el.className;
          const isOut = classes.includes("outgoing");
          const isIn = classes.includes("incoming");
          const textEl = el.querySelector(".content");
          const text = textEl ? textEl.textContent.trim() : "";
          let time = "";
          const statusEl = el.querySelector(".status");
          if (statusEl) {
            const st = statusEl.querySelector(".sender-timestamp .timestamp");
            time = st ? st.textContent.trim() : statusEl.textContent.trim();
          }
          result.push({
            from: isOut ? "You" : "Contact",
            text,
            time,
            direction: isOut ? "outgoing" : isIn ? "incoming" : "",
          });
        });
        return result;
      });
      res.json(messages);
      // Removed the delayed inbox update here as well to avoid disrupting the conversation view.
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
});

/**
 * updateInboxes:
 * Loops through each account index (0-9) and navigates to its messages page.
 * Extracts conversation previews and upserts the latest data into the inboxes table.
 * Phone numbers are normalized by removing non-digits.
 * If the resulting number is 10 digits, a default country code ("1") is prepended.
 * This stored number (without a plus) is then used to build itemIds.
 */
async function updateInboxes() {
  try {
    const { data: activeCampaigns } = await supabase
      .from("campaigns")
      .select("id")
      .eq("status", "active");
    if (activeCampaigns && activeCampaigns.length > 0) {
      console.log("Active campaign running. Skipping inbox update.");
      return;
    }
    for (let accountIndex = 0; accountIndex < 10; accountIndex++) {
      try {
        await page.goto(`${config.base_url}/u/${accountIndex}/messages`, { waitUntil: "networkidle2" });
        await page.waitForSelector("ol.list", { visible: true, timeout: 7000 });
        await new Promise((r) => setTimeout(r, 2000));
        const conversations = await page.evaluate(() => {
          const items = document.querySelectorAll("li.list-item");
          const list = [];
          items.forEach((li) => {
            const container = li.querySelector(".container");
            const unread = container && !container.classList.contains("read");
            const phoneEl = li.querySelector(".title .participants");
            const snippetEl = li.querySelector(".subtitle .preview");
            const timeEl = li.querySelector(".title .timestamp");
            const phoneNumber = phoneEl ? phoneEl.textContent.trim() : "";
            const snippet = snippetEl ? snippetEl.textContent.trim() : "";
            const timestamp = timeEl ? timeEl.textContent.trim() : "";
            if (phoneNumber) {
              list.push({ phoneNumber, snippet, timestamp, unread });
            }
          });
          return list;
        });
        for (const conv of conversations) {
          let normalizedPhone = conv.phoneNumber.replace(/\D/g, '');
          if (normalizedPhone.length === 10) {
            normalizedPhone = "1" + normalizedPhone;
          }
          const { error: upsertError } = await supabase
            .from("inboxes")
            .upsert({
              backend_id: config.backendId,
              account_index: accountIndex,
              phone_number: normalizedPhone, // Stored without a plus sign but including country code
              last_message: conv.snippet,
              last_message_timestamp: new Date().toISOString(),
              unread_count: conv.unread ? 1 : 0,
              updated_at: new Date().toISOString(),
            }, { onConflict: ["backend_id", "account_index", "phone_number"] });
          if (upsertError) {
            console.error("Error upserting inbox for phone number", normalizedPhone, upsertError);
          }
        }
        console.log(`Updated inbox for account index ${accountIndex}.`);
      } catch (innerErr) {
        console.error(`Error updating inbox for account index ${accountIndex}:`, innerErr);
      }
    }
    console.log("Inboxes updated.");
  } catch (err) {
    console.error("updateInboxes error:", err);
  }
}

setInterval(() => {
  updateInboxes();
}, 600000);

app.listen(config.port, () => console.log(`Listening on port ${config.port}.`));

(async () => {
  try {
    while (!page || page.isClosed()) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("Waiting 10 seconds before initial inbox update...");
    await new Promise((r) => setTimeout(r, 10000));
    // updateInboxes();
  } catch (startupErr) {
    console.error("Error during startup inbox update:", startupErr);
  }
})();
