import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HiiLogo from './HiiLogo.svelte';

describe('HiiLogo', () => {
  it('renders stable vector geometry without depending on a font', () => {
    const { container } = render(HiiLogo);
    const logo = container.querySelector('svg');

    expect(logo).toHaveAttribute('viewBox', '0 0 84 52');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('circle')).toBeInTheDocument();
    expect(container.querySelector('rect[x="69"][y="4"]')).toHaveAttribute('rx', '1');
  });

  it('exposes an accessible image label when used without a labelled link', () => {
    render(HiiLogo, { title: 'HII' });

    expect(screen.getByRole('img', { name: 'HII' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'HII' })).not.toHaveAttribute('aria-hidden');
  });
});
