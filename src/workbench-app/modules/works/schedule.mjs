export function hasSchedule(work) {
  return Boolean(work?.scheduledDate && work?.startTime && work?.endTime)
}

export function scheduleLabel(work) {
  return hasSchedule(work) ? `${work.scheduledDate} ${work.startTime}–${work.endTime}` : '尚未排期'
}

export function scheduleGroups(works, includeDone = false) {
  const visible = works.filter(work => includeDone || work.status !== 'done')
  const days = new Map()
  for (const work of visible.filter(hasSchedule)) {
    if (!days.has(work.scheduledDate)) days.set(work.scheduledDate, [])
    days.get(work.scheduledDate).push(work)
  }
  return {
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime)),
    })),
    unscheduled: visible.filter(work => !hasSchedule(work)),
  }
}
