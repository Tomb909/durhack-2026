// Features that are switched off for now.

/**
 * Cards made from typed words (the "Add any word" boxes, and the made cards kept from before).
 * Off for now. To turn it on for one visit, add `?words=1` to the address; to turn it on for
 * good, make this `true`. The rules and the word server are untouched: only the page's way in is closed.
 */
export const WORD_CARDS: boolean = new URLSearchParams(globalThis.location?.search ?? '').get('words') === '1';

/**
 * A handwritten word the camera reads that is no built-in card is made into a card, the same way
 * as a typed word. On. To turn it off for one visit (such a word then stays "?"), add `?words=0`.
 */
export const CAMERA_WORDS: boolean = new URLSearchParams(globalThis.location?.search ?? '').get('words') !== '0';
