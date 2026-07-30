import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HiiLogo from './HiiLogo.svelte';

describe('HiiLogo', () => {
  it('renders the uppercase Helvetica wordmark', () => {
    const { container } = render(HiiLogo);
    const logo = container.querySelector('.hii-wordmark');

    expect(logo).toHaveTextContent('HII');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('exposes an accessible image label when used without a labelled link', () => {
    render(HiiLogo, { title: 'HII' });

    expect(screen.getByRole('img', { name: 'HII' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'HII' })).not.toHaveAttribute('aria-hidden');
  });
});
