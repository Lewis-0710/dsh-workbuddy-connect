/**
 * Scheduling and catch-up orchestration for daily check-in (UTC+8).
 *
 * Modeled after dsh-qoder-connect's CheckInScheduler:
 * - JsonFileCheckInStore persists checkin records and up to 30 history log rows to checkin-status.json
 * - Supports per-variant daily schedule minuteOfDay (UTC+8)
 * - Supports startup and post-config catch-up sweeps
 * - Re-arms timer dynamically on configuration change
 *
 * @module dsh-workbuddy-connect/checkin-scheduler
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkBuddyCheckInResult } from './checkin.ts'
import { getUtc8DateString } from './checkin.ts'
import { workbuddyPluginDataDir } from './paths.ts'

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant.
   */
  checkIn: (signal?: AbortSignal) => Promise<WorkBuddyCheckInResult>
  /**
   * The moment this variant checks in, as minutes past midnight in UTC+8.
   */
  minuteOfDay: () => number
  onClaimed?: () => void
}

export interface CheckInLogItem {
  id: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
}

export interface CheckInRecord {
  lastDate: string
  lastAt: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
  logs?: CheckInLogItem[] | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
  clearLogs(variantId: string): void
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(workbuddyPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  clearLogs(variantId: string): void {
    try {
      const all = this.readAll()
      if (all[variantId]) {
        all[variantId] = {
          ...all[variantId],
          logs: [],
        }
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
      }
    } catch {
      // Best-effort persistence
    }
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      const existing = all[variantId]
      const existingLogs = existing?.logs ?? []
      const newLog: CheckInLogItem = {
        id: `${record.lastDate}-${record.lastAt}`,
        date: record.lastDate,
        timestamp: record.lastAt,
        status: record.status,
        ...record.amount === undefined ? {} : { amount: record.amount },
        ...record.message === undefined ? {} : { message: record.message },
      }
      const updatedLogs = [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, 30)
      all[variantId] = {
        ...record,
        logs: updatedLogs,
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * The default moment a variant checks in: 600 = 10:00 (UTC+8).
 */
export const DEFAULT_CHECK_IN_MINUTE = 600

/** Clamp any stored/typed value onto a real minute of the day. */
export function normalizeCheckInMinute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE
  const whole = Math.trunc(value)
  if (whole < 0 || whole > 1439) return DEFAULT_CHECK_IN_MINUTE
  return whole
}

/**
 * Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
 * Five seconds past the configured minute are used so the request lands after
 * the upstream has flipped the day over rather than on the boundary itself.
 */
export function msUntilNextCheckIn(minuteOfDay: number, nowMs: number = Date.now()): number {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const d = new Date(nowMs)
  // Calculate current UTC+8 wall clock
  const utc8Time = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  const targetUtc8 = new Date(utc8Time.getTime())
  targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0)

  let diff = targetUtc8.getTime() - utc8Time.getTime()
  if (diff <= 0) {
    // Today's moment has passed, schedule for tomorrow
    targetUtc8.setDate(targetUtc8.getDate() + 1)
    diff = targetUtc8.getTime() - utc8Time.getTime()
  }
  return diff
}

/**
 * Whether today's configured check-in moment (UTC+8) has already passed.
 */
export function isPastCheckInTime(minuteOfDay: number, nowMs: number = Date.now()): boolean {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const d = new Date(nowMs)
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  return utc8.getHours() * 60 + utc8.getMinutes() >= minute
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: WorkBuddyCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: WorkBuddyCheckInResult) => void) | undefined
  private readonly now: () => number

  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly inFlight = new Set<string>()
  private readonly nextRuns = new Map<string, number>()
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.disposed) return
    void this.sweepAll(true)
    this.rearm()
  }

  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll(true)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  rearm(): void {
    if (this.disposed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns.clear()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs)
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweepAll(false, target.variantId).finally(() => { this.rearm() })
      }, delay)
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  nextRunAt(variantId: string): number | undefined {
    return this.nextRuns.get(variantId)
  }

  async sweepAll(isCatchUp: boolean, only?: string): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()
    const today = getUtc8DateString(nowMs)

    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      if (this.inFlight.has(target.variantId)) continue
      this.inFlight.add(target.variantId)
      try {
        await this.sweepOne(target, isCatchUp, nowMs, today)
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  private async sweepOne(
    target: VariantCheckInTarget,
    isCatchUp: boolean,
    nowMs: number,
    today: string,
  ): Promise<void> {
    const record = this.store.read(target.variantId)
    const settledToday = record?.lastDate === today
      && (record.status === 'claimed' || record.status === 'already-claimed')

    if (settledToday) {
      if (!isCatchUp) {
        this.store.write(target.variantId, {
          lastDate: today,
          lastAt: nowMs,
          status: 'already-claimed',
          ...record.amount === undefined ? {} : { amount: record.amount },
          message: 'Scheduled check-in ran; today was already claimed',
        })
      }
      return
    }

    if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return

    let result: WorkBuddyCheckInResult
    try {
      result = await target.checkIn()
    } catch {
      return
    }

    try {
      if (result.status !== 'error') {
        this.store.write(target.variantId, {
          lastDate: result.date,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
        })
        if (result.status === 'claimed') {
          target.onClaimed?.()
        }
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }
}
