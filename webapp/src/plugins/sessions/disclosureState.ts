


const MAX_DISCLOSURE_ENTRIES = 500;


export function setPersistedDisclosure(map: Map<string, boolean>, key: string, value: boolean): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_DISCLOSURE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}


export const approvalPreviewOpenState = new Map<string, boolean>();
