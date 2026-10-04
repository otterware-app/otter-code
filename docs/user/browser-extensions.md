# Browser extensions

The desktop app's browser runs Chrome extensions, such as a password manager, in every preview tab.

Add one from the Chrome Web Store: open the puzzle button in a browser tab's toolbar and choose
**Visit Web Store**, or use **Settings → Browser Extensions → Chrome Web Store**. On an
extension's page, choose **Add to** the app and confirm. Pin an extension from the puzzle menu to
keep its button in the toolbar; its popup opens from there.

**Settings → Browser Extensions** turns extensions on or off, shows what each can read, and
removes them. Developer mode loads an unpacked extension from a folder.

Extensions are installed once for every thread, but each environment and browser profile keeps its
own extension data, as it keeps its own site logins. Sign in to an extension once per environment.
Incognito tabs run no extensions.

Extensions that talk to a desktop app through native messaging can't reach it. 1Password, for
example, works on its own, unlocked with your account password rather than the 1Password app.
