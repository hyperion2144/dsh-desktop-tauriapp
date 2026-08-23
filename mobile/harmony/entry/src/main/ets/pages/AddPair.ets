import { router } from '@kit.ArkUI';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { Theme } from '../common/Theme';
import { createPairStore, PairLogic, PairInput, PairStorage } from '../common/PairLogic';

// 复用 Index 的存储适配（独立实例）
class PairStorageAdapter implements PairStorage {
  private pref: preferences.Preferences | null = null;
  private mem: Map<string, string> = new Map();

  async init(ctx: common.UIAbilityContext): Promise<void> {
    try {
      this.pref = await preferences.getPreferences(ctx, 'dsh-mobile');
      this.mem.forEach((v, k) => { this.pref?.putSync(k, v); });
      if (this.mem.size > 0) this.pref?.flush();
    } catch (e) { /* 内存态 */ }
  }
  getItem(key: string): string | null {
    const c = this.mem.get(key);
    if (c !== undefined) return c;
    if (this.pref != null) {
      const v = this.pref.getSync(key, '') as string;
      if (v !== '') return v;
    }
    return null;
  }
  setItem(key: string, value: string): void {
    this.mem.set(key, value);
    if (this.pref != null) { this.pref.putSync(key, value); this.pref.flush(); }
  }
}

@Entry
@Component
struct AddPair {
  @State tab: number = 0; // 0=扫码 1=输入
  @State input: string = '';
  @State token: string = '';
  @State err: string = '';
  @State scanning: boolean = false;
  private store: PairStorageAdapter = new PairStorageAdapter();

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.store.init(ctx).catch(() => { /* 内存态 */ });
  }

  scan(): void {
    this.scanning = true;
    this.err = '';
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.ALL],
        enableMultiMode: true,
        enableAlbum: true,
      };
      scanBarcode.startScanForResult(getContext(this), options)
        .then((result: scanBarcode.ScanResult) => {
          this.scanning = false;
          const text = result?.originalValue ?? '';
          this.parseAndDone(text);
        })
        .catch((e: Error) => {
          this.scanning = false;
          this.err = '扫码失败：' + (e?.message ?? String(e));
        });
    } catch (e) {
      this.scanning = false;
      this.err = '扫码不可用（设备不支持或权限未开）：' + String(e);
    }
  }

  parseAndDone(raw: string, extraToken: string = ''): void {
    const p = PairLogic.parsePairInput(raw, extraToken);
    if (p == null) {
      this.err = '无法解析：请粘贴 dsh-mobile:// 链接、http(s) 配对链接，或输入 host:端口 并填写令牌';
      return;
    }
    this.err = '';
    const st = createPairStore(this.store);
    st.add({ token: p.token, base: p.base, name: '扫码配对', entryUrl: p.entryUrl });
    st.active(p.base);
    router.back();
    router.pushUrl({
      url: 'pages/WebPage',
      params: { base: p.base, url: PairLogic.buildEntryUrl(p) },
    });
  }

  build() {
    Column() {
      // 顶部：标题 + 返回（原型 .top）
      Row() {
        Button('‹ 返回')
          .backgroundColor(Color.Transparent)
          .fontColor(Theme.Accent)
          .onClick(() => router.back())
        Text('添加配对')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(Theme.Text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .margin({ bottom: Theme.Sp16 })

      // 分段控件：扫码配对 / 输入地址（原型 .seg）
      Row() {
        Button('扫码配对')
          .fontSize(12)
          .fontColor(this.tab === 0 ? Color.White : Theme.Text2)
          .backgroundColor(this.tab === 0 ? Theme.Accent : Color.Transparent)
          .borderRadius(8)
          .layoutWeight(1)
          .height(34)
          .onClick(() => { this.tab = 0; })
        Button('输入地址')
          .fontSize(12)
          .fontColor(this.tab === 1 ? Color.White : Theme.Text2)
          .backgroundColor(this.tab === 1 ? Theme.Accent : Color.Transparent)
          .borderRadius(8)
          .layoutWeight(1)
          .height(34)
          .onClick(() => { this.tab = 1; })
      }
      .width('100%')
      .padding(3)
      .backgroundColor(Theme.Panel2)
      .border({ width: 0.5, color: Theme.Line })
      .borderRadius(10)
      .margin({ bottom: Theme.Sp16 })

      if (this.tab === 0) {
        // 扫码面板（原型 vScan）
        Column() {
          Text('扫描桌面端「设置 → 手机访问」的配对二维码')
            .fontSize(13)
            .fontColor(Theme.Text2)
            .margin({ bottom: Theme.Sp16 })
          Button(this.scanning ? '扫码中…' : '开始扫码')
            .fontSize(14)
            .fontColor(Color.White)
            .backgroundColor(Theme.Accent)
            .borderRadius(Theme.RadiusBtn)
            .width('100%')
            .height(44)
            .margin({ bottom: Theme.Sp8 })
            .onClick(() => this.scan())
          if (this.err !== '') {
            Text(this.err)
              .fontSize(12)
              .fontColor(Theme.Err)
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ top: Theme.Sp8 })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Center)
      } else {
        // 输入面板（原型 vInput）
        Column() {
          Text('输入配对地址（host:port 或完整配对链接）')
            .fontSize(13)
            .fontColor(Theme.Text2)
            .margin({ bottom: Theme.Sp8 })
            .width('100%')
          TextInput({ placeholder: '192.168.1.23:3091 或 dsh-mobile://pair?token=…', text: this.input })
            .placeholderColor(Theme.Text2)
            .fontColor(Theme.Text)
            .backgroundColor(Theme.Panel)
            .border({ width: 0.5, color: Theme.Line })
            .borderRadius(Theme.RadiusBtn)
            .padding(12)
            .margin({ bottom: Theme.Sp8 })
            .onChange((v: string) => { this.input = v; })
          TextInput({ placeholder: '配对令牌（链接已含令牌时可留空）', text: this.token })
            .placeholderColor(Theme.Text2)
            .fontColor(Theme.Text)
            .backgroundColor(Theme.Panel)
            .border({ width: 0.5, color: Theme.Line })
            .borderRadius(Theme.RadiusBtn)
            .padding(12)
            .margin({ bottom: Theme.Sp8 })
            .onChange((v: string) => { this.token = v; })
          if (this.err !== '') {
            Text(this.err)
              .fontSize(12)
              .fontColor(Theme.Err)
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ top: Theme.Sp4 })
          }
        }
        .width('100%')
      }

      Button('配对并进入')
        .fontSize(14)
        .fontColor(Color.White)
        .backgroundColor(Theme.Accent)
        .borderRadius(Theme.RadiusBtn)
        .width('100%')
        .height(44)
        .margin({ top: Theme.Sp16 })
        .onClick(() => this.parseAndDone(this.input, this.token))

      Text('令牌一次性 + 限时；配对成功后从列表进入，同一桌面仅一个实例')
        .fontSize(12)
        .fontColor(Theme.Text2)
        .textAlign(TextAlign.Center)
        .margin({ top: Theme.Sp12 })
        .width('100%')
    }
    .padding({ left: Theme.Sp16, right: Theme.Sp16, top: Theme.Sp24, bottom: Theme.Sp16 })
    .backgroundColor(Theme.Bg)
    .width('100%')
    .height('100%')
    // 底部导航栏已隐藏（EntryAbility），这里兜底延伸安全区，消除残留白边
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
