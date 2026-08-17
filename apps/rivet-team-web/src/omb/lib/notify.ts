export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return null
  return Notification.requestPermission()
}

export function showNotification(
  _frame: { title?: string; body?: string; botId: string; threadId?: string },
  _onOpen: (botId: string) => void,
): void {}
