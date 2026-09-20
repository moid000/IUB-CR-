import * as notificationSvc from '../services/notificationService.js';

/**
 * Notification endpoints — read/mark-read only. There is deliberately NO
 * create/update/delete controller: notifications are created exclusively by
 * server-side services (content fan-out + lazy reminder generation), so no
 * client payload can ever forge a recipient, section, type, or dedupe key.
 */

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const wrapList = (fn) => async (req, res, next) => {
  try {
    const { items, pagination } = await fn(req);
    res.json({ success: true, data: items, pagination });
  } catch (err) {
    next(err);
  }
};

export const listMyNotifications = wrapList(notificationSvc.listMyNotifications);
export const getUnreadCount = wrap(notificationSvc.countMyUnread);
export const getUnreadCountByType = wrap(notificationSvc.countMyUnreadByType);
export const markNotificationsReadByType = wrap(notificationSvc.markMyNotificationsReadByType);
export const markNotificationRead = wrap(notificationSvc.markMyNotificationRead);
export const markAllNotificationsRead = wrap(notificationSvc.markAllMyNotificationsRead);
export const listNotificationsAdmin = wrapList(notificationSvc.listNotificationsAdmin);
