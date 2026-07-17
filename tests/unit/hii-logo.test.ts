import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HiiLogo from '../../src/lib/components/HiiLogo.svelte';

describe('HiiLogo', () => {
  it('renders the lowercase Helvetica wordmark', () => {
    const { container } = render(HiiLogo);
    const logo=container.querySelector('.hii-wordmark');
    expect(logo).toHaveTextContent('hii');
    expect(logo).toHaveAttribute('aria-hidden','true');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });
  it('can expose an accessible label',()=>{const {getByRole}=render(HiiLogo,{title:'HII'});expect(getByRole('img',{name:'HII'})).toBeInTheDocument()});
});
