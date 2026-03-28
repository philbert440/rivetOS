/**
 * ask_user tool tests
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createAskUserTool } from './ask-user.js';

describe('ask_user', () => {
  it('has correct tool metadata', () => {
    const tool = createAskUserTool();
    assert.equal(tool.name, 'ask_user');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('question'));
  });

  it('returns a free text question', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: 'What color do you prefer?' });
    assert.ok(result.includes('What color do you prefer?'));
  });

  it('returns a yes/no question with options', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Should I deploy to production?',
      type: 'yes_no',
    });
    assert.ok(result.includes('Should I deploy to production?'));
    assert.ok(result.includes('Yes / No'));
  });

  it('returns yes/no with default value', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Continue?',
      type: 'yes_no',
      default_value: 'yes',
    });
    assert.ok(result.includes('default: yes'));
  });

  it('returns a multiple choice question', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Which framework?',
      type: 'multiple_choice',
      choices: ['Next.js', 'Remix', 'Astro'],
    });
    assert.ok(result.includes('Which framework?'));
    assert.ok(result.includes('1. Next.js'));
    assert.ok(result.includes('2. Remix'));
    assert.ok(result.includes('3. Astro'));
  });

  it('includes context when provided', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Which database?',
      context: 'You mentioned wanting to self-host.',
    });
    assert.ok(result.includes('Context: You mentioned wanting to self-host.'));
    assert.ok(result.includes('Which database?'));
  });

  it('shows default value for free text', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'What port?',
      default_value: '3000',
    });
    assert.ok(result.includes('Default: 3000'));
  });

  it('shows default value for multiple choice', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Pick one',
      type: 'multiple_choice',
      choices: ['A', 'B', 'C'],
      default_value: 'B',
    });
    assert.ok(result.includes('Default: B'));
  });

  it('errors on empty question', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: '' });
    assert.ok(result.includes('Error'));
  });

  it('errors on missing question', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('errors on whitespace-only question', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: '   ' });
    assert.ok(result.includes('Error'));
  });

  it('errors on invalid type', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: 'test', type: 'radio' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('invalid type'));
  });

  it('errors on multiple_choice without choices', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: 'Pick', type: 'multiple_choice' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('at least 2'));
  });

  it('errors on multiple_choice with only 1 choice', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({
      question: 'Pick',
      type: 'multiple_choice',
      choices: ['Only one'],
    });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('at least 2'));
  });

  it('defaults to free_text when type not specified', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: 'How are you?' });
    // Should not include "Options:" or numbered choices
    assert.ok(!result.includes('Options:'));
    assert.ok(!result.includes('1.'));
  });
});
