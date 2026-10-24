// The no-daemon-running way to leave a note on a bot - replaces lab_log.md's
// role in CLAUDE.md's documented workflow. Pure local DB write, no gateway
// connection, same "cheap and safe to run anytime" spirit as checkup.ts.
//
// Usage: bun tasks/note.ts <botname> "observation text" [--author=name]

import { addBotNote, listBotNotes } from '../db/notes';

const [botName, ...rest] = process.argv.slice(2);
if (!botName) {
    console.error('Usage: bun tasks/note.ts <botname> "observation text" [--author=name]');
    process.exit(1);
}

const authorArg = rest.find(a => a.startsWith('--author='));
const author = authorArg?.slice('--author='.length);
const content = rest.filter(a => !a.startsWith('--author=')).join(' ').trim();

if (!content) {
    console.log(`Recent notes for "${botName}":`);
    for (const note of listBotNotes(botName, 20).reverse()) {
        console.log(`[${new Date(note.created_at).toLocaleString()}]${note.author ? ` (${note.author})` : ''} ${note.content}`);
    }
    process.exit(0);
}

const note = addBotNote(botName, content, author);
console.log(`Noted (#${note.id}).`);
