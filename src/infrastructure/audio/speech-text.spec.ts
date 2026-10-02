import { toSpeechText } from './speech-text';

describe('toSpeechText', () => {
  it('strips bold, italic and inline code', () => {
    expect(toSpeechText('Use **Redis** com _TTL_ e `SET NX`.')).toBe('Use Redis com TTL e SET NX.');
  });

  it('removes headings, list markers and emoji', () => {
    const md = '## Avaliação\n\n- Ponto forte 👍\n- Melhorar testes\n1. Próximo passo';
    expect(toSpeechText(md)).toBe('Avaliação. Ponto forte. Melhorar testes. Próximo passo');
  });

  it('keeps link labels and drops code blocks', () => {
    expect(toSpeechText('Veja [a doc](http://x.y)\n```js\nconst a = 1\n```\nfim')).toBe('Veja a doc. fim');
  });

  it('leaves plain sentences untouched', () => {
    const plain = 'Como você lidaria com milhares de sessões simultâneas?';
    expect(toSpeechText(plain)).toBe(plain);
  });
});
