/** Only website buttons use the counter; signed update feeds keep their original URLs. */
export const downloadURL = (app: string, version: string) =>
  `/api/download/${encodeURIComponent(app)}/${encodeURIComponent(version)}`;
