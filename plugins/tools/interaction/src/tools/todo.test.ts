/**
 * todo tool tests
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createTodoTool } from './todo.js';

describe('todo', () => {
  it('has correct tool metadata', () => {
    const tool = createTodoTool();
    assert.equal(tool.name, 'todo');
    assert.ok(tool.description.length > 0);
    assert.equal((tool.parameters as any).type, 'object');
    assert.ok((tool.parameters as any).required.includes('operation'));
  });

  it('lists empty tasks', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'list' });
    assert.equal(result, 'No tasks yet.');
  });

  it('adds a task', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'add', task: 'Set up database' });
    assert.equal(result, 'Added task #1: Set up database');
  });

  it('auto-increments IDs', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'First' });
    const result = await tool.execute({ operation: 'add', task: 'Second' });
    assert.equal(result, 'Added task #2: Second');
  });

  it('lists tasks with counts and status icons', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Set up database' });
    await tool.execute({ operation: 'add', task: 'Build API' });
    await tool.execute({ operation: 'add', task: 'Write tests' });
    await tool.execute({ operation: 'complete', id: 1 });

    const result = await tool.execute({ operation: 'list' });
    assert.ok(result.startsWith('Tasks (1/3 done):'));
    assert.ok(result.includes('[✅] #1 Set up database'));
    assert.ok(result.includes('[  ] #2 Build API'));
    assert.ok(result.includes('[  ] #3 Write tests'));
  });

  it('completes a task', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Deploy' });
    const result = await tool.execute({ operation: 'complete', id: 1 });
    assert.equal(result, 'Completed task #1: Deploy');
  });

  it('updates task text', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Old text' });
    const result = await tool.execute({ operation: 'update', id: 1, new_text: 'New text' });
    assert.ok(result.includes('New text'));
    assert.ok(result.includes('[pending]'));
  });

  it('updates task status', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Working on it' });
    const result = await tool.execute({ operation: 'update', id: 1, status: 'in_progress' });
    assert.ok(result.includes('[in_progress]'));
  });

  it('updates both text and status', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Original' });
    const result = await tool.execute({ operation: 'update', id: 1, new_text: 'Changed', status: 'done' });
    assert.ok(result.includes('Changed'));
    assert.ok(result.includes('[done]'));
  });

  it('shows in_progress icon in list', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'In progress task' });
    await tool.execute({ operation: 'update', id: 1, status: 'in_progress' });
    const result = await tool.execute({ operation: 'list' });
    assert.ok(result.includes('[🔧] #1 In progress task'));
  });

  it('removes a task', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Temp' });
    const result = await tool.execute({ operation: 'remove', id: 1 });
    assert.equal(result, 'Removed task #1');

    const list = await tool.execute({ operation: 'list' });
    assert.equal(list, 'No tasks yet.');
  });

  it('IDs dont reset after remove', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'First' });
    await tool.execute({ operation: 'add', task: 'Second' });
    await tool.execute({ operation: 'remove', id: 1 });
    const result = await tool.execute({ operation: 'add', task: 'Third' });
    assert.equal(result, 'Added task #3: Third');
  });

  it('errors on add without text', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'add' });
    assert.ok(result.startsWith('Error'));
  });

  it('errors on add with empty text', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'add', task: '   ' });
    assert.ok(result.startsWith('Error'));
  });

  it('errors on complete nonexistent task', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'complete', id: 99 });
    assert.ok(result.includes('not found'));
  });

  it('errors on update nonexistent task', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'update', id: 99, status: 'done' });
    assert.ok(result.includes('not found'));
  });

  it('errors on remove nonexistent task', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'remove', id: 99 });
    assert.ok(result.includes('not found'));
  });

  it('errors on invalid operation', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'explode' });
    assert.ok(result.includes('unknown operation'));
  });

  it('errors on complete without id', async () => {
    const tool = createTodoTool();
    const result = await tool.execute({ operation: 'complete' });
    assert.ok(result.startsWith('Error'));
  });

  it('errors on invalid status', async () => {
    const tool = createTodoTool();
    await tool.execute({ operation: 'add', task: 'Test' });
    const result = await tool.execute({ operation: 'update', id: 1, status: 'exploded' });
    assert.ok(result.includes('invalid status'));
  });

  it('each tool instance has independent state', async () => {
    const tool1 = createTodoTool();
    const tool2 = createTodoTool();

    await tool1.execute({ operation: 'add', task: 'Tool 1 task' });
    const list2 = await tool2.execute({ operation: 'list' });
    assert.equal(list2, 'No tasks yet.');
  });
});
