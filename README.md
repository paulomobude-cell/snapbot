> [!IMPORTANT]
> **Thank You for Your Support!**
>
> Snapbot is a hobby Project of mine which I released almost a year ago and its gaining a lot of traction recently. If you find this project useful or are interested in futher development, please consider starring the repository. It helps me know that you're interested and encourages future development. Your support is greatly appreciated!

> 
# SnapBot v2

SnapBot is a modern, browser-level automation library designed specifically for Snapchat.
Built on top of Puppeteer, SnapBot enables developers to create powerful Snapchat bots without relying on internal APIs or reverse engineering — all through the familiar browser environment.

Whether you're automating daily snaps, managing multiple accounts, or building complex chat workflows, SnapBot abstracts the hard parts so you can focus on what matters: the logic and creativity behind your automation.

> **New: live dashboard.** Run SnapBot as a server (Railway) with a web chat dashboard (Vercel), similar to wppconnect-server. Add multiple accounts and log in from the dashboard. It's a live mirror by default; for a chat you can turn on **preservation** — once both sides consent (linked own-account, or the other person sends a code) it keeps that chat's messages, including deleted and disappearing ones, plus photos/videos/snaps (Cloudflare R2 or the data volume). See [DEPLOY.md](DEPLOY.md).

## 💼 Use Cases
* Daily content distribution via snaps
* Streak automation for agencies or influencers
* CRM-style customer engagement bots
* AI-integrated messaging workflows
* Custom Snapchat tools for businesses

## 🚀 Features

* **Image Uploads**: Send images directly through the bot.
* **Full Chat Automation**: Automate sending and receiving messages.
* **Snap Shortcuts**: Quickly send snaps to predefined contacts.
* **Smart Notification Blocking**: Prevent unwanted notifications during automation.
* **Advanced Contact Handling**: Manage contacts efficiently within the bot.
* **Multiple Account Support**: Handle multiple Snapchat accounts simultaneously.
* **Custom Captions**: Send snaps with personalized captions.
* **Snapstreak Maintenance**: Ensure your streaks never break again.

## 📦 Installation

1. **Clone the repository**:

   ```bash
   git clone https://github.com/Emmanuel-Rods/SnapBot
   ```



2. **Navigate to the project directory**:

   ```bash
   cd SnapBot
   ```



3. **Install the necessary dependencies**:

   ```bash
   npm install
   ```



4. **Set up environment variables**:

   ```bash
   cp .env.example .env
   ```



Edit the `.env` file and add your Snapchat credentials:

```env
USER_NAME=<Your Snapchat Username>
USER_PASSWORD=<Your Snapchat Password>
```



## 🛠️ Usage

To run the bot, use the following command:

```bash
npm run bot
```



This command will start SnapBot, logging into Snapchat, capturing a snap, and sending it to your specified contacts.

If you run into a CAPTCHA when using SnapBot, see this guide for a solution:  
[Bypass CAPTCHA](https://github.com/Emmanuel-Rods/SnapBot/blob/main/bypass%20captcha.md)

## 📚 Available Methods

SnapBot provides a comprehensive set of methods to interact with Snapchat:

* `launchSnapchat(config)`: Opens Snapchat in a browser. Set `headless` to `false` in the config to see the browser.
* `login(credentials)`: Logs into Snapchat using the provided credentials.
* `isLogged()`: Checks if the user is currently logged in.
* `captureSnap(options)`: Takes a snap and applies a caption.
* `send(person)`: Sends the snap to the specified recipient(s).
* `closeBrowser()`: Closes the browser session.
* `screenshot(options)`: Saves a screenshot of the current screen state.
* `logout()`: Logs out of the current Snapchat account, allowing you to log in with another account without closing the browser.
* `wait(time)`: Pauses the script for a specified duration (in milliseconds).
* `openFriendRequests()`: Opens the friend requests section.
* `listRecipients()`: Lists all available recipients.
* `sendMessage(options)`: Sends a message with the specified options.
* `saveCookies(username)`: Saves the current session cookies for the given username.
* `useCookies(username)`: Loads saved session cookies for the given username.
* `extractChatData(chatID)`: Extracts chat data for the specified chat ID.
* `userStatus()`: Retrieves the current user's status.
* `blockTypingNotifications(boolean)`: Enables or disables typing notifications based on the boolean value.
* `useShortcut(shortcutsArray)`: Applies predefined shortcuts from the provided array.

## 📖 Documentation

For detailed information on each method and advanced usage, please refer to the [docs.md](https://github.com/Emmanuel-Rods/SnapBot/blob/main/docs.md) file in the repository.


### 🤝 Contributing

We welcome contributions!
If you have ideas, feature requests, bug reports, or improvements for the documentation:

* 📬 **Open an issue** on GitHub
* ✉️ **Email suggestions** to [alewsor@gmail.com](mailto:alewsor@gmail.com)
* 📝 **Help improve the README or `docs.md`** — every edit counts!

Whether it’s code, feedback, or typo fixes — your support makes SnapBot better for everyone. 💛

### 🧩 Stability Notice

SnapBot relies heavily on DOM selectors, which means updates to the Snapchat web interface can occasionally break its functionality.

I’m actively working on an auto-update system to detect and adapt to these changes — and **your help is welcome**!

If you're interested in helping build this system, feel free to:

* 💬 Open an issue
* 🛠️ Submit a pull request
* ✉️ Reach out at [alewsor@gmail.com](mailto:alewsor@gmail.com)

Together we can make SnapBot more stable and smarter. 🧠✨

### 🚀 Showcase Your Bots

Built something cool using SnapBot?
We’d love to feature your creations in our showcase!
Share your bots with us by opening an issue or sending an email to [alewsor@gmail.com](mailto:alewsor@gmail.com), and get your project highlighted for the community to see.


### 📝 TODO
 * [ ] Add comprehensive JSDoc comments for all methods and functions
 * [ ] Implement better error handling and user-friendly error messages
 

> [!WARNING]
> 
> This project is intended for educational and research purposes only. The developers and contributors are not responsible for any misuse or damages resulting from the use of this software. Users are solely responsible for ensuring their compliance with all applicable laws and terms of service.

## 📬 Contact

For any queries or contributions, feel free to reach out at: [alewsor@gmail.com](mailto:alewsor@gmail.com)

