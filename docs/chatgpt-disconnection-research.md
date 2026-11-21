# Removing disconnected Sign in with ChatGPT entries

Checked: 2026-11-13.

## Question and conclusion

After disconnecting LearnHarness in ChatGPT, can its entry also be removed from **Settings → Security and login → Sign in with ChatGPT**?

**No documented procedure for deleting an already-disconnected entry was found in the official sources reviewed.** OpenAI documents disconnection and token revocation, but neither a separate Delete/Forget control for disconnected entries nor a public client-deregistration API was found.

This is a documentation finding, not proof that removal is impossible. The sources do not establish whether an account-specific UI control exists, whether OpenAI Support can remove an entry, or whether entries expire. They also do not establish that permanent retention is intended.

This investigation used public, unauthenticated sources. It did not inspect or change a live ChatGPT account, reproduce the private settings UI, or test authenticated deletion requests.

## Evidence

### Session revocation is not client deletion

OpenAI's [Accounts and sessions documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#end-the-renewable-session) states:

> The user can disconnect the app in ChatGPT Settings. Revoking this session does not delete the registered client.

The documented operation is a form-encoded POST to the discovered `revocation_endpoint`, with the refresh token, `token_type_hint=refresh_token`, and issued `client_id`.

**Important boundary:** the quoted statement concerns session revocation. It does not specify whether manually disconnecting in ChatGPT deletes an underlying registration or removes its historical UI entry.

### The documented user action is Disconnect

OpenAI's [Help Center guide](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) describes Login connections as:

> apps and sites where you've already signed in with ChatGPT

Its disconnection instructions end with selecting **Disconnect** and confirming **Disconnect** again. The article does not describe deleting a disconnected row. It also states:

> Disconnecting does not reverse usage already recorded.

That last statement concerns recorded usage; it does not establish a retention policy for the Security and login list.

The first-party [ChatGPT Learn guide](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) likewise says:

> To completely disconnect access for an external partner tool, go to **ChatGPT Settings > Security and login > Sign in with ChatGPT**, select the app, and select **Disconnect**.

Disconnecting **access** and erasing the displayed entry are distinct outcomes. A remaining row alone is not evidence that the app still has authorized access.

### No developer-side deregistration procedure was found

The [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) documents receiving and reusing an issued `client_id`. No registration-management URL or registration-management token is documented in that flow.

The [published SIWC documentation export](https://developers.openai.com/siwc/llms-full.txt) was checked for `registration_client_uri`, `registration_access_token`, `registration_endpoint`, and `7592`; none appeared. No disconnected-entry deletion procedure was found in its deletion-related passages.

The public [OpenID configuration](https://auth.openai.com/.well-known/openid-configuration) advertises:

```json
"revocation_endpoint": "https://auth.openai.com/api/accounts/oauth/revoke"
```

It does not advertise `registration_endpoint` or a client-deletion endpoint. Missing discovery metadata alone does not prove that no endpoint exists.

[RFC 7592 §2.3](https://www.rfc-editor.org/rfc/rfc7592.html#section-2.3) defines an optional, separate client-deletion mechanism using a server-issued client-configuration URL and registration access token. The reviewed OpenAI sources do not establish support for it. An ordinary OAuth access token is not evidence of registration-management authority. Guessing a DELETE URL would not be a supported integration.

## Implications for LearnHarness

- Keep local credential removal and documented session revocation. Neither can promise removal of a row owned by ChatGPT.
- Do not invent an authenticated deletion endpoint or treat a persistent row as proof of a failed local disconnect.
- Current wording that says "remove LearnHarness from ChatGPT" or promises it will stop appearing after ChatGPT disconnection is stronger than the documented guarantee. A future wording change should describe **revoking LearnHarness's access**, without promising visual removal. No runtime or UI-copy changes were made in this investigation.

## Remaining verification

A redacted screenshot of the disconnected entry's details and available menus could establish whether this account exposes a separate Remove/Delete control. Do not include email addresses, tokens, or other private details.

If no such control is present, [OpenAI Support](https://help.openai.com/en/articles/6614161-how-can-i-contact-support) is the appropriate place to ask whether disconnected entries can be removed and what retention policy applies. The documented contact method is the chat bubble at help.openai.com. Support's ability to delete these entries is unconfirmed.
