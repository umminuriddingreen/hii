// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';
import { SiteAnalysis } from './site-analysis';

export const metadata: Metadata = {
  title: 'Site analysis',
  description: 'A source-linked site workspace for architecture students.',
  alternates: { canonical: '/site-analysis' }
};

export default function SiteAnalysisPage() {
  return <main id="hii-main"><SiteAnalysis /></main>;
}
