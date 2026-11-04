// bs58@4 (a transitive dev dependency used only to cross-check our base58) ships no types.
declare module 'bs58' {
  const bs58: { encode(source: Uint8Array): string; decode(source: string): Uint8Array };
  export default bs58;
}
