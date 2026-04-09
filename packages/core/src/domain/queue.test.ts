/**
 * MessageQueue tests — enqueue, turn lifecycle, command parsing.
 */

import { describe, it, beforeEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { MessageQueue, isCommand, parseCommand } from './queue.js';
import type { InboundMessage } from '@rivetos/types';

function makeMessage(text: string): InboundMessage {
  return {
    id: String(Date.now()),
    userId: 'user-1',
    channelId: 'chan-1',
    chatType: 'private',
    text,
    platform: 'test',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

describe('MessageQueue', () => {
  let queue: MessageQueue;
  let processed: string[];

  beforeEach(() => {
    queue = new MessageQueue();
    processed = [];
    queue.setHandler(async (msg) => {
      processed.push(msg.text);
    });
  });

  it('should process immediately when idle', async () => {
    await queue.enqueue(makeMessage('hello'));
    assert.deepEqual(processed, ['hello']);
  });

  it('should queue messages when a turn is active', async () => {
    // Simulate a handler that takes time
    const order: string[] = [];
    const handlerQueue = new MessageQueue();
    handlerQueue.setHandler(async (msg) => {
      order.push(`start:${msg.text}`);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${msg.text}`);
    });

    // First message starts processing
    const p1 = handlerQueue.enqueue(makeMessage('first'));

    // Second message arrives while first is processing — should be queued
    const p2 = handlerQueue.enqueue(makeMessage('second'));

    await p1;
    await p2;

    // Both should have been processed in order
    assert.ok(order.includes('start:first'));
    assert.ok(order.includes('end:first'));
    assert.ok(order.includes('start:second'));
    assert.ok(order.includes('end:second'));

    // First should start before second
    assert.ok(order.indexOf('start:first') < order.indexOf('start:second'));
  });

  it('should report queue depth', async () => {
    assert.equal(queue.depth, 0);
  });

  it('should clear queued messages', async () => {
    // Begin a turn manually to queue messages
    queue.beginTurn();
    await queue.enqueue(makeMessage('queued-1'));
    await queue.enqueue(makeMessage('queued-2'));
    assert.equal(queue.depth, 2);

    queue.clear();
    assert.equal(queue.depth, 0);

    // End the turn — nothing should process
    await queue.endTurn();
    assert.deepEqual(processed, []);
  });

  it('beginTurn/endTurn lifecycle', async () => {
    queue.beginTurn();

    await queue.enqueue(makeMessage('during-turn'));
    assert.deepEqual(processed, [], 'Message should be queued, not processed');
    assert.equal(queue.depth, 1);

    await queue.endTurn();
    assert.deepEqual(processed, ['during-turn'], 'Message should process after endTurn');
    assert.equal(queue.depth, 0);
  });
});

describe('isCommand', () => {
  it('should recognize valid commands', () => {
    assert.ok(isCommand('/stop'));
    assert.ok(isCommand('/interrupt'));
    assert.ok(isCommand('/steer some message'));
    assert.ok(isCommand('/new'));
    assert.ok(isCommand('/status'));
    assert.ok(isCommand('/model'));
    assert.ok(isCommand('/think'));
    assert.ok(isCommand('/reasoning'));
    assert.ok(isCommand('/context'));
    assert.ok(isCommand('/clear'));
  });

  it('should reject non-commands', () => {
    assert.ok(!isCommand('hello'));
    assert.ok(!isCommand('/unknown'));
    assert.ok(!isCommand('/'));
    assert.ok(!isCommand(''));
    assert.ok(!isCommand('stop'));
  });
});

describe('parseCommand', () => {
  it('should parse command and args', () => {
    const result = parseCommand('/steer go faster');
    assert.ok(result);
    assert.equal(result.command, 'steer');
    assert.equal(result.args, 'go faster');
  });

  it('should parse command without args', () => {
    const result = parseCommand('/stop');
    assert.ok(result);
    assert.equal(result.command, 'stop');
    assert.equal(result.args, '');
  });

  it('should return null for non-commands', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand('/badcommand'), null);
  });
});
