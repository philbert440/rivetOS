import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { parseCron, nextCronFiring } from './cron.js'

describe('parseCron', () => {
  it('parses every-minute "* * * * *"', () => {
    const c = parseCron('* * * * *')
    assert.equal(c.minutes.size, 60)
    assert.equal(c.hours.size, 24)
    assert.equal(c.daysOfMonth.size, 31)
    assert.equal(c.months.size, 12)
    assert.equal(c.daysOfWeek.size, 7)
    assert.equal(c.domRestricted, false)
    assert.equal(c.dowRestricted, false)
  })

  it('parses lists "0 8,20 * * *"', () => {
    const c = parseCron('0 8,20 * * *')
    assert.deepEqual([...c.minutes], [0])
    assert.deepEqual([...c.hours].sort((a, b) => a - b), [8, 20])
  })

  it('parses ranges and steps "*/15 9-17 * * 1-5"', () => {
    const c = parseCron('*/15 9-17 * * 1-5')
    assert.deepEqual([...c.minutes].sort((a, b) => a - b), [0, 15, 30, 45])
    assert.deepEqual([...c.hours].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17])
    assert.deepEqual([...c.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5])
    assert.equal(c.dowRestricted, true)
  })

  it('rejects wrong field count', () => {
    assert.throws(() => parseCron('* * * *'), /5 fields/)
    assert.throws(() => parseCron('* * * * * *'), /5 fields/)
  })

  it('rejects out-of-range values', () => {
    assert.throws(() => parseCron('60 * * * *'))
    assert.throws(() => parseCron('* 24 * * *'))
    assert.throws(() => parseCron('* * 0 * *'))
  })

  it('rejects garbage', () => {
    assert.throws(() => parseCron('abc def ghi jkl mno'))
  })
})

describe('nextCronFiring', () => {
  it('finds the next "0 8,20 * * *" firing', () => {
    const cron = parseCron('0 8,20 * * *')
    const from = new Date(2026, 4, 2, 10, 30, 0) // 10:30 → next is 20:00 same day
    const next = nextCronFiring(cron, from)
    assert.equal(next.getHours(), 20)
    assert.equal(next.getMinutes(), 0)
    assert.equal(next.getDate(), 2)
  })

  it('rolls over to next day after last firing', () => {
    const cron = parseCron('0 8,20 * * *')
    const from = new Date(2026, 4, 2, 21, 0, 0) // after 20:00 → next is 8:00 tomorrow
    const next = nextCronFiring(cron, from)
    assert.equal(next.getHours(), 8)
    assert.equal(next.getDate(), 3)
  })

  it('skips quarter-hour past current minute', () => {
    const cron = parseCron('*/15 * * * *')
    const from = new Date(2026, 4, 2, 10, 7, 30)
    const next = nextCronFiring(cron, from)
    assert.equal(next.getMinutes(), 15)
    assert.equal(next.getHours(), 10)
  })

  it('strictly advances past current firing time', () => {
    const cron = parseCron('30 14 * * *')
    const from = new Date(2026, 4, 2, 14, 30, 0) // exactly at firing → next is tomorrow
    const next = nextCronFiring(cron, from)
    assert.equal(next.getDate(), 3)
    assert.equal(next.getHours(), 14)
    assert.equal(next.getMinutes(), 30)
  })

  it('handles weekday restriction (POSIX OR rule)', () => {
    // "fire at 9am on the 1st of the month OR on Mondays"
    const cron = parseCron('0 9 1 * 1')
    // Pick a Friday that is not the 1st: 2026-05-08 (Fri)
    const from = new Date(2026, 4, 8, 12, 0, 0)
    const next = nextCronFiring(cron, from)
    // Next match: Mon 2026-05-11 at 09:00
    assert.equal(next.getFullYear(), 2026)
    assert.equal(next.getMonth(), 4)
    assert.equal(next.getDate(), 11)
    assert.equal(next.getDay(), 1)
    assert.equal(next.getHours(), 9)
  })
})
