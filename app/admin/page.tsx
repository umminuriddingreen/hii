// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';
import { AccountsOverview } from '@/components/admin/AccountsOverview';

export const metadata: Metadata = {
  title: 'Accounts',
  description: 'Operator view of accounts on this deployment.',
  // Never advertise the operator surface, and never let it be linked out of.
  robots: { index: false, follow: false, nocache: true }
};

export default function AdminPage() {
  return <AccountsOverview />;
}
