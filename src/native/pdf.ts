import * as FS from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

const DIR = `${FS.documentDirectory}reports/`;

/** HTML → PDF with the OS print engine (WKWebView / Android WebView), fully offline. */
export async function renderPdf(html: string, stem: string): Promise<string> {
  await FS.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  // Letter landscape at 72dpi; the report's @page CSS sets margins.
  const { uri } = await Print.printToFileAsync({ html, width: 792, height: 612 });
  const dest = `${DIR}${stem}-${Date.now().toString(36)}.pdf`;
  await FS.moveAsync({ from: uri, to: dest });
  return dest;
}

export async function sharePdf(path: string): Promise<void> {
  await Sharing.shareAsync(path, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Share report' });
}
