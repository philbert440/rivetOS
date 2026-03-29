/**
 * Transcript Logger — writes voice session transcripts to markdown files.
 *
 * File path: {transcriptDir}/{YYYY-MM-DD}/{HH-MM-SS}-{sessionId}.md
 * Incrementally saves after each message so nothing is lost on crash.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class TranscriptLogger {
  private sessionId: string;
  private startTime: Date;
  private participants: Set<string>;
  private messages: Array<{ speaker: string; text: string; timestamp: Date }>;
  private filePath: string;
  private voice: string;

  constructor(sessionId: string, transcriptDir: string, voice: string) {
    this.sessionId = sessionId;
    this.startTime = new Date();
    this.participants = new Set();
    this.messages = [];
    this.voice = voice;

    const dateStr = this.startTime.toISOString().split('T')[0];
    const timeStr = this.startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
    this.filePath = path.join(transcriptDir, dateStr, `${timeStr}-${sessionId}.md`);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  addMessage(speaker: string, text: string): void {
    this.participants.add(speaker);
    this.messages.push({ speaker, text, timestamp: new Date() });
    this.save(false);
  }

  finalize(): void {
    this.save(true);
  }

  private save(isFinal: boolean): void {
    const duration = Math.floor((Date.now() - this.startTime.getTime()) / 60000);
    const durationStr = isFinal ? `${duration} minutes` : `${duration} minutes (in progress)`;
    this.participants.add('Phil');
    const participantsStr = Array.from(this.participants).join(', ');

    let content = `# Voice Session — ${this.startTime.toLocaleDateString()} ${this.startTime.toLocaleTimeString()}\n\n`;
    content += `**Duration:** ${durationStr}\n`;
    content += `**Participants:** ${participantsStr}\n`;
    content += `**Voice:** ${this.voice}\n\n---\n\n`;

    for (const msg of this.messages) {
      content += `**${msg.speaker}:** ${msg.text}\n\n`;
    }

    fs.writeFileSync(this.filePath, content, 'utf8');
  }
}
