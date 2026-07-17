import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HiiLogo from '../../src/lib/components/HiiLogo.svelte';

describe('HiiLogo', () => {
  it('renders stable font-independent vector geometry', () => {
    const { container } = render(HiiLogo);
    const svg=container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox','0 0 84 52');
    expect(svg).toHaveAttribute('aria-hidden','true');
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('rect[x="69"][y="4"]')).toBeInTheDocument();
  });
  it('can expose an accessible label',()=>{const {getByRole}=render(HiiLogo,{title:'HII'});expect(getByRole('img',{name:'HII'})).toBeInTheDocument()});
});
