// SPDX-License-Identifier: LicenseRef-BSL-1.1
export type HiiNotificationSeverity = 'info' | 'success' | 'attention' | 'urgent';
export type HiiNotificationRoute = 'canvas' | 'text' | 'device';
export type HiiNotificationDeliveryStatus = 'delivered' | 'queued' | 'not_configured';

export type HiiNotificationDelivery = { route: HiiNotificationRoute; status: HiiNotificationDeliveryStatus; detail: string };
export type HiiNotification = {
  schemaVersion: 1;
  kind: 'hii.notification';
  id: string;
  source: string;
  title: string;
  body: string;
  severity: HiiNotificationSeverity;
  coordinate?: string;
  proofRefs: string[];
  deliveries: HiiNotificationDelivery[];
  createdAt: string;
  readAt?: string;
};
