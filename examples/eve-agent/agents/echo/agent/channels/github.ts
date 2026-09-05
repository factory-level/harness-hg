// GitHub, the Eve way (docs/channels/github): the channel takes a GitHub
// App's webhooks at /eve/v1/github, checks the HMAC signature, and answers
// in the issue / PR / review thread when a comment carries the invocation
// token (@<botName>). Credentials are the platform's connection projection
// (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET,
// GITHUB_APP_SLUG in the environment, ADR-152) - nothing is authored here;
// botName falls back to GITHUB_APP_SLUG.
import { githubChannel } from "eve/channels/github";

export default githubChannel({});
