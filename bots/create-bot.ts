#!/usr/bin/env bun
import { cp, readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

function generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function replaceInFile(filePath: string, replacements: Record<string, string>) {
    let content = await readFile(filePath, 'utf-8');
    for (const [key, value] of Object.entries(replacements)) {
        content = content.replaceAll(key, value);
    }
    await writeFile(filePath, content);
}

/**
 * Creates a new bot's `bots/{username}/` directory from the template.
 * Throws on validation failure (bad username, already exists, ...) rather
 * than exiting the process, so this is safe to call from a long-running
 * caller like `manager/daemon.ts` and not just the CLI block below.
 * Returns the (possibly auto-generated) username.
 */
export async function createBot(username?: string, serverOverride?: string, hideChat?: boolean): Promise<string> {
    // Generate username if not provided
    const botUsername = username || generateRandomString(9);

    // Validate username
    if (botUsername.length > 12) {
        throw new Error('Username must be 12 characters or less');
    }

    if (!/^[a-zA-Z0-9]+$/.test(botUsername)) {
        throw new Error('Username must be alphanumeric');
    }

    const templateDir = join(import.meta.dir, '_template');
    const botDir = join(import.meta.dir, botUsername);

    // Check if template exists
    if (!existsSync(templateDir)) {
        throw new Error(`Template directory not found at ${templateDir}`);
    }

    // Check if bot already exists
    if (existsSync(botDir)) {
        throw new Error(`Bot directory already exists at ${botDir}`);
    }

    // Copy template directory
    await cp(templateDir, botDir, { recursive: true });
    console.log(`Created bot directory: ${botDir}`);

    // Generate random password
    const password = generateRandomString(12);

    // Replace placeholders in all files
    const replacements = {
        '{{USERNAME}}': botUsername,
        '{{PASSWORD}}': password,
    };

    const files = await readdir(botDir);
    for (const file of files) {
        const filePath = join(botDir, file);
        await replaceInFile(filePath, replacements);
        console.log(`Created ${file}`);
    }

    const envPath = join(botDir, 'bot.env');

    // Override server if --local or --server= was passed
    if (serverOverride) {
        await replaceInFile(envPath, { 'rs-sdk-demo.fly.dev': serverOverride });
        console.log(`Server set to: ${serverOverride}`);
    }
    if (serverOverride === 'localhost') {
        // The lite runner builds its cache origin from SERVER, so a bare
        // 'localhost' dials port 80; and SERVER with a port would then be
        // mistaken for the gateway. Name both explicitly.
        await replaceInFile(envPath, { 'SERVER=localhost\n': 'SERVER=localhost:8888\nGATEWAY_URL=ws://localhost:7780\n' });
        console.log(`Local stack: engine at localhost:8888, gateway at ws://localhost:7780`);
    }

    // Public chat is shown by default; disable it with --no-chat / --hide-chat
    if (hideChat) {
        await replaceInFile(envPath, { 'SHOW_CHAT=true': 'SHOW_CHAT=false' });
        console.log(`Public chat: disabled`);
    } else {
        console.log(`Public chat: enabled (default)`);
    }

    console.log(`\n✓ Bot "${botUsername}" created successfully!`);
    console.log(`\nCredentials saved in bots/${botUsername}/bot.env`);
    console.log(`\nTo get started:`);
    console.log(`  Use MCP execute_code on "${botUsername}" — it opens the browser client automatically.`);
    console.log(`  For a standalone script, first open the browser bot client using the credentials in bot.env and leave it running.`);
    console.log(`  Scripts do not start a game client. Once the browser is attached, run:`);
    console.log(`  bun bots/${botUsername}/script.ts`);
    return botUsername;
}

if (import.meta.main) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let serverOverride: string | undefined;
    let hideChat = false;

    for (const arg of args) {
        if (arg === '--local') {
            serverOverride = 'localhost';
        } else if (arg.startsWith('--server=')) {
            serverOverride = arg.slice('--server='.length);
        } else if (arg === '--no-chat' || arg === '--hide-chat') {
            hideChat = true;
        } else if (arg === '--show-chat') {
            // Public chat is now on by default; accepted as a no-op for back-compat.
        } else {
            positional.push(arg);
        }
    }

    createBot(positional[0], serverOverride, hideChat).catch(err => {
        console.error(err instanceof Error ? `Error: ${err.message}` : err);
        process.exit(1);
    });
}
