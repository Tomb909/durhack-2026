// Features that are switched off for now.

/**
 * Cards made from typed words (the "Add any word" boxes, and the made cards kept from before).
 * Off for now. To turn it on for one visit, add `?words=1` to the address; to turn it on for
 * good, make this `true`. The rules and the word server are untouched: only the page's way in is closed.
 */
export const WORD_CARDS: boolean = new URLSearchParams(globalThis.location?.search ?? '').get('words') === '1';
