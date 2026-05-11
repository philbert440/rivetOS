import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { scheduleToCronMatch } from './heartbeat-scheduler.js'

describe('scheduleToCronMatch', () => {
  it('passes 5-field cron through unchanged', () => {
    assert.equal(scheduleToCronMatch('0 8,20 * * *').match, '0 8,20 * * *')
    assert.equal(scheduleToCronMatch('*/30 * * * *').match, '*/30 * * * *')
    assert.equal(scheduleToCronMatch('  */5 * * * *  ').match, '*/5 * * * *')
  })

  it('treats numeric schedules as minute intervals', () => {
    assert.equal(scheduleToCronMatch(15).match, '*/15 * * * *')
    assert.equal(scheduleToCronMatch(30).match, '*/30 * * * *')
    assert.equal(scheduleToCronMatch(60).match, '0 */1 * * *')
    assert.equal(scheduleToCronMatch(120).match, '0 */2 * * *')
  })

  it('converts minute-suffix strings to crontab', () => {
    assert.equal(scheduleToCronMatch('5m').match, '*/5 * * * *')
    assert.equal(scheduleToCronMatch('30min').match, '*/30 * * * *')
    assert.equal(scheduleToCronMatch('45').match, '*/45 * * * *')
  })

  it('converts hour-suffix strings to crontab', () => {
    assert.equal(scheduleToCronMatch('1h').match, '0 */1 * * *')
    assert.equal(scheduleToCronMatch('4hr').match, '0 */4 * * *')
  })

  it('rounds sub-minute schedules up with a warning', () => {
    const r1 = scheduleToCronMatch('30s')
    assert.equal(r1.match, '*/1 * * * *')
    assert.ok(r1.warning?.includes('rounded'))

    const r2 = scheduleToCronMatch('90sec')
    assert.equal(r2.match, '*/2 * * * *')
    assert.ok(r2.warning)
  })

  it('throws on unrecognized strings', () => {
    assert.throws(() => scheduleToCronMatch('every other tuesday'))
    assert.throws(() => scheduleToCronMatch('not-a-cron'))
  })

  it('rejects sub-1 minute numeric intervals', () => {
    assert.throws(() => scheduleToCronMatch(0))
    assert.throws(() => scheduleToCronMatch(-5))
  })
})
