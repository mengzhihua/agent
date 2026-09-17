import { HtmlDriver } from "./html.js";
import { formatSnapshot, type BrowserDriver, type PageView, type Screenshot } from "./types.js";

export class BrowserSession {
  constructor(private driver: BrowserDriver = new HtmlDriver()) {}

  use(driver: BrowserDriver): void {
    this.driver = driver;
  }

  async open(url: string, signal: AbortSignal): Promise<string> {
    return formatSnapshot(await this.driver.open(url, signal));
  }

  async click(ref: string, signal: AbortSignal): Promise<string> {
    return formatSnapshot(await this.driver.click(ref, signal));
  }

  async type(ref: string, text: string): Promise<string> {
    return formatSnapshot(await this.driver.type(ref, text));
  }

  snapshot(): string {
    return formatSnapshot(this.driver.snapshot());
  }

  view(): PageView {
    return this.driver.snapshot();
  }

  html(): string {
    return this.driver.html();
  }

  url(): string {
    return this.driver.url();
  }

  async screenshot(): Promise<Screenshot> {
    return this.driver.screenshot();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
