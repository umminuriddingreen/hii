// SPDX-License-Identifier: LicenseRef-BSL-1.1
import styles from './HiiWebAccess.module.css';

export function HiiWebAccess() {
  return (
    <main className={styles.access}>
      <span className={styles.wordmark}>hii</span>
      <nav className={styles.actions} aria-label="HII account access">
        <a href="#log-in">Log in</a>
        <a href="#create-account">Create an account</a>
      </nav>
    </main>
  );
}

export default HiiWebAccess;
