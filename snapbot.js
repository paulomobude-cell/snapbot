import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";

puppeteer.use(Stealth());

import fs from "fs";
import fsPromise from "fs/promises";
import { discoverChats } from "./server/chat-discovery.js";
import { extractVisibleMessages } from "./server/chat-reader.js";

function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

const lastTestedVersion = "v13.38.0";

export default class SnapBot {
  constructor() {
    this.page = null;
    this.browser = null;
  }
  async launchSnapchat(obj, cookiefile) {
    try {
      const options = {
        ...obj,
        // executablePath: "/usr/bin/google-chrome",  // for docker
      };
      this.browser = await puppeteer.launch(options);

      if (cookiefile) {
        try {
          const cookiesString = fs.readFileSync(
            `./${cookiefile}-cookies.json`,
            "utf-8"
          );
          const cookies = JSON.parse(cookiesString);
          await this.browser.setCookie(...cookies);
          console.log("Cookies set");
        } catch (error) {
          console.error("Error in using cookies", error);
        }
      }

      const context = this.browser.defaultBrowserContext();

      await context.overridePermissions("https://web.snapchat.com", [
        "camera",
        "microphone",
      ]);

      this.page = await context.newPage();

      await this.page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
      });
      await this.page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
      );

      //gets the version
      this.page.on("console", (msg) => {
        if (msg.type() === "log") {
          const text = msg.text();
          if (text.includes("Snapchat")) {
            console.log("Snapchat for Web Build info:", text);
            const version = text.match(/v\d+\.\d+\.\d+/);
            const currentVersion = version?.[0];
            if (!currentVersion) return;
            console.log("Version", currentVersion);
            //check version
            if (currentVersion != lastTestedVersion) {
              console.warn(
                `⚠️  Warning: Some methods were last tested on version ${lastTestedVersion} \n\n` +
                  `Detected current version is ${currentVersion}\n\n` +
                  `Some features might not work properly.\n` +
                  `If you encounter issues, please try updating the project using 'git pull'.\n` +
                  `If the problem persists, consider raising an issue or contacting the developer.`
              );
            }
          }
        }
      });

      // hook for setting up the page before Snapchat loads (request blocking, media capture)
      if (this.onPageCreated) await this.onPageCreated(this.page, this.browser);

      await this.page.goto("https://www.snapchat.com/?original_referrer=none");
    } catch (error) {
      console.error(`Error while Starting Snapchat : ${error}`);
      throw error;
    }
  }

  async login(credentials) {
    const { username, password } = credentials || {};
    if (!username?.trim() || !password) {
      throw new Error("Snapchat username and password are required");
    }
    if (!this.page || this.page.isClosed?.()) {
      throw new Error("Snapchat browser is not ready. Restart the session and try again.");
    }

    const page = this.page;
    const USERNAME = 'input[name="accountIdentifier"], #ai_input';
    const PASSWORD = '#password, input[type="password"]';
    const SUBMIT = 'button[type="submit"]';

    // Snapchat sometimes opens a verification page instead of a login form.
    // Never submit a form or pretend login succeeded when fields are missing.
    let userInput = await page.$(USERNAME).catch(() => null);
    let passwordInput = await page.$(PASSWORD).catch(() => null);
    if (!userInput && !passwordInput) {
      userInput = await page.waitForSelector(USERNAME, {
        visible: true, timeout: 8000,
      }).catch(() => null);
      passwordInput = await page.$(PASSWORD).catch(() => null);
    }
    if (!userInput && !passwordInput) {
      throw new Error("Snapchat login form is unavailable. Check the live screen for verification or a page error.");
    }

    const submitStep = async () => {
      const button = await page.$(SUBMIT).catch(() => null);
      if (button) await button.click();
      else await page.keyboard.press("Enter");
    };

    if (userInput) {
      await userInput.click({ clickCount: 3 });
      await userInput.type(username.trim(), { delay: 45 });
      // A username/password form submits once; two-step forms submit to advance.
      if (!passwordInput) {
        await submitStep();
        try {
          passwordInput = await page.waitForSelector(PASSWORD, {
            visible: true, timeout: 12000,
          });
        } catch {
          throw new Error("Snapchat did not show a password field. Complete the next step on the live screen (CAPTCHA, 2FA, or login error).");
        }
      }
    }

    passwordInput ||= await page.$(PASSWORD);
    if (!passwordInput) {
      throw new Error("Snapchat password field is unavailable. Use the live screen to continue.");
    }
    await passwordInput.type(password, { delay: 45 });
    await submitStep();
    // The session manager checks for the chat list and handles verification.
  }

  async isLogged() {
    const defaultLoginBtn = await this.page.$("#ai_input");
    const loginBtn = await this.page.$('input[name="accountIdentifier"]');

    if (defaultLoginBtn || loginBtn) {
      return false;
    }
    return true;
  }

  async handlePopup() {
    try {
      const notNowBtn = "button.NRgbw.eKaL7.Bnaur";
      const notNowBtnHandle = await this.page.waitForSelector(notNowBtn, {
        visible: true,
        timeout: 5000,
      });
      console.log("Checking for 'Not now' button...");
      if (notNowBtnHandle) {
        await this.page.waitForSelector(notNowBtn, {
          visible: true,
          timeout: 5000,
        });
        await this.page.click(notNowBtn);
        console.log("Clicked 'Not now' button.");
      } else {
        console.log("not found");
      }
    } catch (error) {
      console.log(`could not find Popup`);
    }
  }

  async captureSnap(obj) {
    try {
      //updated version here v2.0
      let captureBtnFound = false;
      const captureButtonSelector = "button.FBYjn.gK0xL.A7Cr_.m3ODJ";

      const captureButton = await this.page.$(captureButtonSelector);
      if (captureButton) {
        const isVisible = (await captureButton.boundingBox()) !== null;
        if (isVisible) {
          await captureButton.click();
          captureBtnFound = true;
        }
      }
      if (!captureBtnFound) {
        const svgButtonSelector = "button.qJKfS";
        await delay(1000);

        let isSVGbuttonFound = null;
        let retries = 0;
        const maxRetries = 3;

        while (!isSVGbuttonFound && retries < maxRetries) {
          try {
            isSVGbuttonFound = await this.page.waitForSelector(
              svgButtonSelector,
              {
                visible: true,
                timeout: 15000,
              }
            );
          } catch (error) {
            console.log("Couldn't find the SVG selector, retrying...");
          }

          if (!isSVGbuttonFound) {
            retries++;
            console.log(`Retries left: ${maxRetries - retries}`);
            await delay(1000);
          }
        }

        if (isSVGbuttonFound) {
          await this.page.click(svgButtonSelector);
          console.log("clicked svg button");
        } else {
          console.log("SVG button not found after maximum retries.");
        }
        // Capture button
        if (isSVGbuttonFound) {
          await delay(1000);
          const captureButtonSelector = "button.FBYjn.gK0xL.A7Cr_.m3ODJ"; 
          const captureButton = await this.page.waitForSelector(
            captureButtonSelector,
            { visible: true }
          );
          await captureButton.click();
          console.log("✅ Clicked the capture button");
        }
      }

      await delay(3000);

      // 📸 Add custom image if `obj.path` exists
      if (obj.path) {
        try {
          const imageToBase64 = await fsPromise.readFile(obj.path, "base64");
          const imageData = `data:image/png;base64,${imageToBase64}`;

          // Wait for container
          const containerSelector = "#snap-preview-container";
          await this.page.waitForSelector(containerSelector, { visible: true });

          await this.page.evaluate(
            (containerSelector, imageData) => {
              const container = document.querySelector(containerSelector);
              if (container) {
                const img = container.querySelector("img");
                if (img) img.src = imageData;
              }
            },
            containerSelector,
            imageData
          );
          // await this.page.evaluate((imageData) => {
          //   const img = document.querySelector("#snap-preview-container img");
          //   if (img) img.src = imageData; // if imageData is already available in the page
          // }, imageData);

          console.log("✅ Image added successfully");
        } catch (error) {
          console.warn("⚠️ Error adding image:", error);
        }
      }

      await delay(1000);

      // 📝 Add caption if provided
      if (obj.caption) {
        await delay(2000);
        const captionButtonSelector = 'button[title="Add a caption"]';
        await this.page.waitForSelector(captionButtonSelector, {
          visible: true,
        });
        await this.page.click(captionButtonSelector);

        await delay(1000);
        const textareaSelector = 'textarea.B9QiX[aria-label="Caption Input"]';
        await this.page.waitForSelector(textareaSelector, { visible: true });
        await this.page.type(textareaSelector, obj.caption, { delay: 100 });

        console.log("✅ Caption added successfully");

        await delay(1000);

        //caption pos
        if (obj.position) {
          const elementHandle = await this.page.$(textareaSelector);
          if (elementHandle) {
            const box = await elementHandle.boundingBox();
            if (box) {
              const startX = box.x + box.width / 2;
              const startY = box.y + box.height / 2;
              const endY = startY + obj.position;

              await this.page.mouse.move(startX, startY); // Move to starting position
              await this.page.mouse.down(); // Click and hold (start drag)
              await this.page.mouse.move(startX, endY, { steps: 10 }); // Drag smoothly
              await this.page.mouse.up(); // Release (drop)
            }
          }
        }
      }
    } catch (error) {
      console.error("❌ Error in capturing the snap:", error);
    }
  }

  async send(person) {
    try {
      const button = await this.page.$("button.YatIx.fGS78.eKaL7.Bnaur"); //updated this

      if (button) {
        console.log("Button found!");
        await button.click();
      } else {
        console.log("Button not found.");
      }
      await delay(1000);
      let selected = "";
      person = person.toLowerCase();
      if (person == "bestfriends") {
        selected = "ul.UxcmY li  div.Ewflr.cDeBk.A8BRr ";
      } else if (person == "groups") {
        selected = "li div.RbA83";
      } else if (person == "friends") {
        selected = "li div.Ewflr";
      } else if (person == "all") {
        console.log("not implemented yet");
      } else {
        throw new Error("Option not found");
      }
      const accounts = await this.page.$$(selected);
      for (const account of accounts) {
        const isFriendVisible = await account.evaluate(
          (el) => el.offsetWidth > 0 && el.offsetHeight > 0
        ); // Check if the div is visible
        if (isFriendVisible) {
          await account.click(); // Click on the div element
        } else {
          console.log("account not found.");
        }
      }
      const sendButton = await this.page.$("button[type='submit']"); 
      await sendButton.click();
      delay(5000);
    } catch (error) {
      console.error("Error while sending snap", error);
    }
  }

  async closeBrowser() {
    await delay(5000);
    await this.browser.close();
    console.log("Snapchat closed");
  }

  async screenshot(obj) {
    await this.page.screenshot(obj);
  }

  async logout() {
    await this.page.waitForSelector("#downshift-1-toggle-button");
    await this.page.click("#downshift-1-toggle-button");
    await this.page.click("#downshift-1-item-9");
    console.log("Logged Out");
    await delay(12000);
  }

  async wait(time) {
    return new Promise(function (resolve) {
      setTimeout(resolve, time);
    });
  }
  //beta
  async openFriendRequests() {
    await this.page.waitForSelector('button[title="View friend requests"]');
    const requests = await this.page.$('button[title="View friend requests"]');
    await requests.click();
  }

  async listRecipients() {
    await this.page.waitForSelector(
      "div.ReactVirtualized__Grid__innerScrollContainer"
    );
    const lists = await this.page.$$("div[role='listitem']");
    const data = [];

    for (const listItem of lists) {
      const titleSpan = await listItem.$("span[id^='title-']");
      if (titleSpan) {
        let id = await this.page.evaluate((el) => el.id, titleSpan);
        const name = await this.page.evaluate(
          (el) => el.textContent.trim(),
          titleSpan
        );
        id = id.replace(/^title-/, "");
        data.push({ id, name });
      }

      //status
    }

    // console.log(data);
    return data;
  }

  async sendMessage(obj) {
    await this.page.waitForSelector(
      "div.ReactVirtualized__Grid__innerScrollContainer"
    );
    const lists = await this.page.$$("div[role='listitem']");

    for (const listItem of lists) {
      const titleSpan = await listItem.$("span[id^='title-']");
      if (titleSpan) {
        const id = await this.page.evaluate((el) => el.id, titleSpan);
        let chatID = "title-" + obj.chat;
        if (id === chatID) {
          if (!obj.alreadyOpen) {
            await titleSpan.click();
          }

          if (obj.message === "") {
            // const cleanedID = obj.chat.replace(/^title-/, "");
            // return this.extractChatData(cleanedID);
          }

          // if its an array
          if (Array.isArray(obj.message)) {
            for (let msg of obj.message) {
              await this.page.waitForSelector('div[role="textbox"].euyIb');
              await this.page.type('div[role="textbox"].euyIb', `${msg}`);
              await this.page.keyboard.press("Enter");
            }
          }
          //if string
          if (typeof obj.message == "string") {
            await this.page.waitForSelector('div[role="textbox"].euyIb');
            await this.page.type('div[role="textbox"].euyIb', obj.message, {
              delay: 200,
            });
            await this.page.keyboard.press("Enter");
          }

          if (obj.exit) {
            // await delay(300);
            await titleSpan.click(); // go back
          }
        }
      }
    }
  }

  async saveCookies(username) {
    try {
      const cookies = await this.browser.cookies();
      fs.writeFileSync(
        `./${username}-cookies.json`,
        JSON.stringify(cookies, null, 2)
      );
      console.log("cookies saved for : ", username);
    } catch (error) {
      console.error("Error in saving cookies", error);
    }
  }

  async useCookies(username) {
    try {
      const cookiesString = fs.readFileSync(`./${username}-cookies.json`);
      const cookies = JSON.parse(cookiesString);
      await this.browser.setCookie(...cookies);
    } catch (error) {
      console.error("Error in using cookies", error);
    }
  }

  async extractChatData(userId) {
    return await this.page.evaluate((userId) => {
      const output = [];
      const $chatList = document.querySelector(`#cv-${userId}`);
      if (!$chatList) return [];

      const listItems = $chatList.querySelectorAll("li.T1yt2");

      let currentTime = null;
      let currentConvo = { time: "", conversation: [] };

      listItems.forEach((li) => {
        const timeElem = li.querySelector("time span");
        if (timeElem) {
          if (currentTime) output.push({ ...currentConvo });
          currentTime = timeElem.textContent.trim();
          currentConvo = { time: currentTime, conversation: [] };
          return;
        }

        const messageBlocks = li.querySelectorAll("li");

        if (messageBlocks.length > 0) {
          messageBlocks.forEach((block) => {
            let sender =
              block.querySelector("header .nonIntl")?.textContent.trim() || "";

            if (!sender) {
              const borderElem = block.querySelector(".KB4Aq");
              if (borderElem) {
                const color = getComputedStyle(borderElem).borderColor;
                if (color === "rgb(242, 60, 87)") sender = "Me";
                else if (color === "rgb(14, 173, 255)") sender = "Them";
                else sender = "Unknown";
              }
            }

            const texts = Array.from(block.querySelectorAll("span.ogn1z")).map(
              (span) => span.textContent.trim()
            );

            texts.forEach((text) => {
              if (text) currentConvo.conversation.push({ from: sender, text });
            });
          });
        } else {
          const borderElem = li.querySelector(".KB4Aq");
          let sender = "Unknown";

          if (borderElem) {
            const color = getComputedStyle(borderElem).borderColor;
            sender = color === "rgb(242, 60, 87)" ? "Me" : "Unknown";
          }

          const text = li.querySelector("span.ogn1z")?.textContent.trim();
          if (text) currentConvo.conversation.push({ from: sender, text });
        }
      });

      if (currentConvo.conversation.length > 0) {
        output.push(currentConvo);
      }

      return output;
    }, userId);
  }

  // Observe rendered sidebar changes without selecting, opening or reading a
  // conversation. The browser tells Node that *something* changed, never
  // transfers message content through this observer.
  async watchChatList(onChange) {
    this._sidebarListener = onChange;
    if (!this._sidebarBridgeInstalled) {
      await this.page.exposeFunction("__snapbotSidebarActivity", () => {
        try { this._sidebarListener?.(); } catch {}
      });
      this._sidebarBridgeInstalled = true;
    }
    return this.page.evaluate(() => {
      const root = document.querySelector("div.ReactVirtualized__Grid__innerScrollContainer");
      if (!root || typeof MutationObserver === "undefined") return false;
      window.__snapbotSidebarObserver?.disconnect();
      if (window.__snapbotSidebarTimer) clearTimeout(window.__snapbotSidebarTimer);
      const observer = new MutationObserver((changes) => {
        if (!changes.some(change => change.type === "childList" || change.type === "characterData")) return;
        if (window.__snapbotSidebarTimer) clearTimeout(window.__snapbotSidebarTimer);
        window.__snapbotSidebarTimer = setTimeout(() => {
          Promise.resolve(window.__snapbotSidebarActivity?.()).catch(() => {});
        }, 250);
      });
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      window.__snapbotSidebarObserver = observer;
      return true;
    });
  }

  // Read all virtualized chats on initial/periodic discovery, but only
  // currently mounted rows on fast refresh. Each snapshot uses a single
  // browser evaluate rather than stale Puppeteer element handles.
  async userStatus({ fullScan = false } = {}) {
    await this.page.waitForSelector("div.ReactVirtualized__Grid__innerScrollContainer");
    const readVisible = () => this.page.evaluate(() => {
      const data = [];
      for (const item of document.querySelectorAll("div[role='listitem']")) {
        const title = item.querySelector("span[id^='title-']");
        if (!title) continue;
        const id = title.id.replace(/^title-/, "");
        const name = title.textContent?.trim();
        if (!id || !name) continue;
        const statusContainer = document.getElementById("status-" + id);
        const status = statusContainer?.parentElement
          ? [...statusContainer.parentElement.querySelectorAll("span")]
            .map(span => span.textContent?.trim())
            .filter(x => x && x !== "·")
          : [];
        const clean = [...new Set(status)];
        data.push({ id, name, status: {
          type: clean[0] || null, time: clean[1] || null, streak: clean[2] || null,
        } });
      }
      return data;
    });
    const evaluateScroll = fn => this.page.evaluate(fn);
    const scrollRoot = () => {
      const inner = document.querySelector("div.ReactVirtualized__Grid__innerScrollContainer");
      if (!inner) return null;
      let el = inner;
      while (el) {
        if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) return el;
        el = el.parentElement;
      }
      return inner;
    };
    return discoverChats({
      readVisible,
      getPosition: () => evaluateScroll(() => {
        const inner = document.querySelector("div.ReactVirtualized__Grid__innerScrollContainer");
        let el = inner;
        while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
        el ||= inner;
        return el ? {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        } : null;
      }),
      scrollTo: top => this.page.evaluate(value => {
        const inner = document.querySelector("div.ReactVirtualized__Grid__innerScrollContainer");
        let el = inner;
        while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
        el ||= inner;
        if (el) el.scrollTop = value;
      }, top),
      pause: time => delay(time),
      fullScan,
    });
  }

  async blockTypingNotifications(shouldBlock) {
    const client = await this.page.createCDPSession();

    await client.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*SendTypingNotification*",
          requestStage: "Request",
        },
      ],
    });

    client.on("Fetch.requestPaused", async (event) => {
      const url = event.request.url;

      if (
        shouldBlock &&
        url.includes(
          "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/SendTypingNotification"
        )
      ) {
        // console.log("[CDPBlock] Aborting request:", url);
        await client.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Failed",
        });
      } else {
        await client.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
      }
    });
  }

  //select
  async useShortcut(shortcutsArray) {
    const button = await this.page.$("button.YatIx.fGS78.eKaL7.Bnaur");
    if (button) {
      console.log("Send Button found!");
      await button.click();
    } else {
      console.log("Send Button not found.");
    }
    await delay(2000);
    for (const emoji of shortcutsArray) {
      const clicked = await this.page.$$eval(
        "div.THeKv button",
        (buttons, emoji) => {
          const btn = buttons.find((b) => b.textContent.trim() === emoji);
          if (btn) {
            btn.click();
            //now press the select
            return true;
          }
          return false;
        },
        emoji
      );

      if (clicked) {
        await this.page.waitForSelector("button.Y7u8A");
        await this.page.click("button.Y7u8A");
        const reclick = await this.page.$$eval(
          "div.THeKv button",
          (buttons, emoji) => {
            const btn = buttons.find((b) => b.textContent.trim() === emoji);
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          },
          emoji
        );
      }
      if (!clicked) {
        console.warn(`Shortcut "${emoji}" not found.`);
      }
    }
    //send button

    const sendButton = await this.page.$("button[type='submit']"); 
    await sendButton.click();
  }

  // Interactive chat selection may occur while Live Screen is displaying
  // search results. The virtualized sidebar (title-<id>) is then unavailable.
  // Clear only Snapchat's own visible chat search and let its regular list
  // render again; the Comnexus search field is entirely separate.
  async clearSnapchatSearch() {
    return this.page.evaluate(() => {
      const field = [...document.querySelectorAll("input")].find(input => {
        const label = (input.getAttribute("placeholder") || input.getAttribute("aria-label") || "").toLowerCase();
        const rect = input.getBoundingClientRect();
        return label.includes("search") && rect.width > 0 && rect.height > 0 && input.value.trim();
      });
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
  }

  // Only the explicitly selected chat is clicked, never a background scan.
  async openChat(chatId) {
    const convoSelector = `[id="cv-${chatId}"]`;
    this.lastChatOpenReason = null;
    if (await this.visibleChatId() === chatId) return true;
    let title = await this.page.$(`span[id="title-${chatId}"]`);
    if (!title && await this.clearSnapchatSearch()) {
      await delay(450);
      title = await this.page.$(`span[id="title-${chatId}"]`);
    }
    // Offscreen rows aren't mounted in Snapchat's virtualized sidebar.
    // Reveal the requested chat by scrolling the list in bounded steps.
    if (!title) {
      const selector = "div.ReactVirtualized__Grid__innerScrollContainer";
      const initial = await this.page.evaluate(sel => {
        const inner = document.querySelector(sel);
        let el = inner;
        while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
        return el?.scrollTop || 0;
      }, selector);
      await this.page.evaluate(sel => {
        const inner = document.querySelector(sel);
        let el = inner;
        while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
        if (el) el.scrollTop = 0;
      }, selector);
      await delay(120);
      title = await this.page.$(`span[id="title-${chatId}"]`);
      for (let step = 0; step < 160 && !title; step++) {
        const moved = await this.page.evaluate(sel => {
          const inner = document.querySelector(sel);
          let el = inner;
          while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
          if (!el) return false;
          const next = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + Math.max(120, el.clientHeight * .72));
          if (next <= el.scrollTop + 1) return false;
          el.scrollTop = next;
          return true;
        }, selector);
        if (!moved) break;
        await delay(95);
        title = await this.page.$(`span[id="title-${chatId}"]`);
      }
      if (!title) {
        // Could also have been above the previously viewed list position.
        await this.page.evaluate((sel) => {
          const inner = document.querySelector(sel);
          let el = inner;
          while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
          if (el) el.scrollTop = 0;
        }, selector);
        await delay(120);
        title = await this.page.$(`span[id="title-${chatId}"]`);
      }
      if (!title) {
        await this.page.evaluate((sel, previous) => {
          const inner = document.querySelector(sel);
          let el = inner;
          while (el && !(el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0)) el = el.parentElement;
          if (el) el.scrollTop = previous;
        }, selector, initial);
        this.lastChatOpenReason = "Conversation not found in Snapchat's rendered/virtualized chat list";
        return false;
      }
    }
    const waitForVisibleChat = async () => {
      try {
        await this.page.waitForSelector(convoSelector, { visible: true, timeout: 5500 });
        return true;
      } catch {
        // A pending render can complete before the next selector poll.
        return await this.visibleChatId().catch(() => null) === chatId;
      }
    };
    // The span itself may be off-screen or non-interactive in some Snapchat
    // layouts. Retry the exact containing chat row even if its child click
    // THROWS (not only when it fails to render a chat).
    let lastError = null;
    try {
      await title.click();
      if (await waitForVisibleChat()) return true;
    } catch (error) { lastError = error; }
    try {
      const rowHandle = await title.evaluateHandle(node => node.closest('[role="listitem"]'));
      const row = rowHandle.asElement();
      if (row) {
        await row.click();
        if (await waitForVisibleChat()) return true;
      }
    } catch (error) { lastError = error; }
    this.lastChatOpenReason = lastError
      ? "Snapchat couldn't open this chat row: " + String(lastError.message || lastError).slice(0,150)
      : "Chat row was selected but Snapchat did not show the conversation";
    return false;
  }

  // Inspect/scroll ONLY the currently opened conversation's scrollable
  // message pane. Never scroll the sidebar or open a Snap. Used only after an
  // explicit request to open and archive the named conversation.
  async historyScroll(chatId, action = "inspect", position = 0) {
    return this.page.evaluate((id, action, position) => {
      const root = document.getElementById("cv-" + id);
      if (!root) return { available: false, moved: false, atTop: false };
      const choices = [root, ...root.querySelectorAll("*")].filter(el => {
        if (el.clientHeight < 80 || el.scrollHeight < el.clientHeight + 35) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      const el = choices.sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (!el) return { available: false, moved: false, atTop: false };
      const before = el.scrollTop;
      if (action === "older") el.scrollTop = Math.max(0, before - Math.max(110, Math.floor(el.clientHeight * .72)));
      if (action === "restore") el.scrollTop = Math.max(0, Number(position) || 0);
      const after = el.scrollTop;
      return { available: true, moved: action === "older" && after < before - 1,
        atTop: after <= 2, scrollTop: after, scrollHeight: el.scrollHeight };
    }, chatId, action, position);
  }

  // returns what a chat currently shows as a flat list, or null if the chat isn't
  // open (so callers can tell "not loaded" from "empty"). Items:
  //   { kind: "text",   from, isMe, text, time }
  //   { kind: "media",  from, isMe, text: "", time, src, mediaType: "image"|"video" }
  //   { kind: "snap",   from, isMe, text: "", time, snapIndex }   tap-to-view snap tile
  //   { kind: "notice", notice: "deleted", from, text, time }      "X deleted a chat"
  // Visibility check only: no clicks, fetches, navigation or read-state writes.
  async visibleChatId() {
    return this.page.evaluate(() => {
      const roots = document.querySelectorAll("[id^='cv-']");
      for (const el of roots) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && rect.height > 0) return el.id.slice(3);
      }
      return null;
    });
  }

  async readMessages(chatId, chatName = "Them", options = {}) {
    const {
      deletedPattern = "\\bdeleted (a|an|the)? ?(chat|snap|message|photo|image|video|voice|audio|sticker|attachment)",
      snapPattern = "\\b(tap to view|tap to replay|tap to load|new snap|received snap)\\b",
    } = options;
    // Read only the already rendered conversation. This evaluation does not
    // click, navigate or make its own request to Snapchat. Opening a chat
    // beforehand is a separate operation that can emit normal read receipts.
    return this.page.evaluate(extractVisibleMessages, chatId, chatName, deletedPattern, snapPattern);
  }

  // Answers matching requests with an empty gRPC "OK" instead of sending them, at
  // browser level so workers are covered too. Used to stop read receipts / typing.
  async blockRequests(patterns) {
    if (this._blockSession) await this._blockSession.detach().catch(() => {});
    if (!patterns.length) return;
    const client = await this.browser.target().createCDPSession();
    this._blockSession = client;
    this.blockedLog = [];
    client.on("Fetch.requestPaused", async (event) => {
      const { requestId, request } = event;
      try {
        const origin = request.headers.Origin || request.headers.origin;
        const headers = [
          { name: "content-type", value: "application/grpc-web+proto" },
          { name: "grpc-status", value: "0" },
          { name: "grpc-message", value: "" },
        ];
        if (origin) {
          headers.push(
            { name: "access-control-allow-origin", value: origin },
            { name: "access-control-allow-credentials", value: "true" },
            { name: "access-control-expose-headers", value: "grpc-status,grpc-message" }
          );
        }
        if (request.method === "OPTIONS") {
          headers.push(
            { name: "access-control-allow-methods", value: "POST, OPTIONS" },
            { name: "access-control-allow-headers", value: request.headers["Access-Control-Request-Headers"] || "*" }
          );
        }
        this.blockedLog.push({ url: request.url, at: Date.now() });
        if (this.blockedLog.length > 100) this.blockedLog.shift();
        await client.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers, body: "" });
      } catch (error) {
        await client.send("Fetch.continueRequest", { requestId }).catch(() => {});
      }
    });
    await client.send("Fetch.enable", {
      patterns: patterns.map((p) => ({ urlPattern: `*${p}*`, requestStage: "Request" })),
    });
  }

  // Keeps a reference to every Blob the page turns into an object URL. Snapchat
  // decrypts media into blobs, so this lets us read images/videos (even ones the
  // page already revoked, like a closed one-time snap). Call before navigating.
  async installMediaCapture(page = this.page, maxBytes = 200 * 1024 * 1024) {
    await page.evaluateOnNewDocument((maxBytes) => {
      const store = new Map(); // url -> { blob, at }
      let total = 0;
      const original = URL.createObjectURL;
      URL.createObjectURL = function (obj) {
        const url = original.apply(this, arguments);
        try {
          if (obj instanceof Blob && obj.size > 2048) {
            store.set(url, { blob: obj, at: Date.now() });
            total += obj.size;
            for (const [key, value] of store) {
              if (total <= maxBytes) break;
              store.delete(key);
              total -= value.blob.size;
            }
          }
        } catch (error) {
          // never break the page
        }
        return url;
      };
      Object.defineProperty(window, "__sbBlobs", { value: store, enumerable: false });
    }, maxBytes);
  }

  // Reads media by URL (blob: from the capture map, or anything fetchable).
  // Returns { base64, type, size } or null.
  async readMedia(src) {
    return await this.page.evaluate(async (src) => {
      try {
        const kept = window.__sbBlobs?.get(src)?.blob;
        const blob = kept || (await (await fetch(src)).blob());
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buffer.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000));
        }
        return { base64: btoa(binary), type: blob.type, size: blob.size };
      } catch (error) {
        return null;
      }
    }, src);
  }

  // Opens the nth tap-to-view snap tile found by readMessages, grabs the media the
  // viewer decrypts, then closes the viewer. Returns readMedia()'s result or null.
  async openReceivedSnap(snapIndex, { timeout = 6000 } = {}) {
    const tile = await this.page.$(`[data-sb-snap="${snapIndex}"]`);
    if (!tile) return null;
    const startedAt = await this.page.evaluate(() => Date.now());
    await tile.click();
    let src = null;
    const end = Date.now() + timeout;
    while (!src && Date.now() < end) {
      await delay(400);
      src = await this.page.evaluate((startedAt) => {
        let best = null;
        for (const [url, { blob, at }] of window.__sbBlobs || []) {
          if (at >= startedAt && (!best || blob.size > best.size)) best = { url, size: blob.size };
        }
        return best?.url || null;
      }, startedAt);
    }
    if (src) await delay(500); // let a video finish loading into its blob
    const media = src ? await this.readMedia(src) : null;
    await this.page.keyboard.press("Escape");
    await delay(600);
    return media;
  }

  // types a message into the currently open chat
  async typeMessage(text) {
    const textbox = 'div[role="textbox"].euyIb';
    await this.page.waitForSelector(textbox, { timeout: 10000 });
    await this.page.type(textbox, text, { delay: 30 });
    await this.page.keyboard.press("Enter");
  }

  // add custom methods
  static extend(methods) {
    Object.assign(SnapBot.prototype, methods);
  }
}
