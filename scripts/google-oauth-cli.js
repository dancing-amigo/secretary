#!/usr/bin/env node
import readline from 'readline';
import { google } from 'googleapis';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682/oauth2callback';

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file']
});

console.log('\nOpen this URL in your browser and approve access:\n');
console.log(authUrl);
console.log('\nPaste the full redirected URL (or just code=... value):\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('> ', async (input) => {
  rl.close();

  try {
    let code = input.trim();
    if (code.startsWith('http')) {
      const u = new URL(code);
      code = u.searchParams.get('code') || '';
    }
    if (!code) throw new Error('authorization code not found');

    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token returned. Re-run and ensure prompt=consent is honored.');
      process.exit(2);
    }

    console.log('\nSet this in Vercel env as GOOGLE_OAUTH_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token);
    console.log('\nOptional: also set GOOGLE_OAUTH_REDIRECT_URI to:');
    console.log(redirectUri);
  } catch (e) {
    console.error('\nFailed to exchange code:', e.message || e);
    process.exit(3);
  }
});
