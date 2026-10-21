import { demoTotpSecret, totpCounter } from "../src/security.js";
const email = process.argv[2];
if (!email)
  throw new Error("Usage: npm run demo:totp -- doctor01.demo@example.com");
console.log(totpCounter(demoTotpSecret(email), Math.floor(Date.now() / 30000)));
