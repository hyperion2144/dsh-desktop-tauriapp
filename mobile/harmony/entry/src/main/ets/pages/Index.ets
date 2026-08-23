import { router } from '@kit.ArkUI';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { Theme } from '../common/Theme';
import { createPairStore, PairLogic, PairEntry, PairInput, PairStorage } from '../common/PairLogic';

// 简化存储适配器：内存态 + preferences 落盘。
class PairStorageAdapter implements PairStorage {
  private pref: preferences.Preferences | null = null;
  private mem: Map<string, string> = new Map();

  async init(ctx: common.UIAbilityContext): Promise<void> {
    try {
      this.pref = await preferences.getPreferences(ctx, 'dsh-mobile');
      this.mem.forEach((v, k) => {
        this.pref?.putSync(k, v);
      });
      if (this.mem.size > 0) {
        this.pref?.flush();
      }
    } catch (e) {
      // 读取失败仅退化为内存态
    }
  }

  getItem(key: string): string | null {
    const cached = this.mem.get(key);
    if (cached !== undefined) return cached;
    if (this.pref != null) {
      const v = this.pref.getSync(key, '') as string;
      if (v !== '') return v;
    }
    return null;
  }

  setItem(key: string, value: string): void {
    this.mem.set(key, value);
    if (this.pref != null) {
      this.pref.putSync(key, value);
      this.pref.flush();
    }
  }
}

/** 单个配对条目的在线状态（fetch HEAD 探测，30s 刷新）。 */
@Component
struct PairCard {
  @Prop @Watch('onBaseChange') base: string = '';
  @Prop name: string = '';
  @Prop entryUrl: string = '';
  @State online: boolean = false;
  // 删除回调（由 Index 传入，ArkTS 组件可用普通属性传函数）
  onRemove: (base: string) => void = () => {};
  private timer: number = -1;

  aboutToAppear(): void {
    this.probe();
    this.timer = setInterval(() => this.probe(), 30000);
  }

  aboutToDisappear(): void {
    if (this.timer >= 0) clearInterval(this.timer);
  }

  onBaseChange(): void {
    this.probe();
  }

  probe(): void {
    const req = http.createHttp();
    req.request(`http://${this.base}/`, { method: http.RequestMethod.HEAD, connectTimeout: 5000, readTimeout: 5000 })
      .then(() => { this.online = true; })
      .catch(() => { this.online = false; })
      .finally(() => req.destroy());
  }

  build() {
    Column() {
      Row({ space: Theme.Sp12 }) {
        // 头像块（首字）
        Column() {
          Text((this.name !== '' ? this.name : this.base).charAt(0).toUpperCase())
            .fontSize(13)
            .fontWeight(FontWeight.Bold)
            .fontColor(Theme.Text2)
        }
        .width(36)
        .height(36)
        .borderRadius(10)
        .backgroundColor(Theme.Panel2)
        .border({ width: 0.5, color: Theme.Line })
        .justifyContent(FlexAlign.Center)

        // 名称 + 状态点 + 地址
        Column() {
          Row({ space: 6 }) {
            Text(this.name !== '' ? this.name : this.base)
              .fontSize(13)
              .fontWeight(FontWeight.Medium)
              .fontColor(Theme.Text)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Circle()
              .width(6)
              .height(6)
              .fill(this.online ? Theme.Ok : Theme.Off)
          }
          .width('100%')

          Text(this.base)
            .fontSize(11)
            .fontColor(Theme.Text2)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        // 进入按钮
        Button('进入')
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor(Theme.Accent)
          .borderRadius(8)
          .height(28)
          .onClick(() => this.enter())

        // 删除按钮（可见 + 弹确认框，不直接删）
        Button('删除')
          .fontSize(12)
          .fontColor(Theme.Err)
          .backgroundColor(Color.Transparent)
          .border({ width: 0.5, color: Theme.Err })
          .borderRadius(8)
          .height(28)
          .onClick(() => this.confirmRemove())
      }
      .width('100%')
    }
    .padding(Theme.Sp16)
    .backgroundColor(Theme.Panel)
    .borderRadius(Theme.RadiusCard)
    .border({ width: 0.5, color: Theme.Line })
  }

  enter(): void {
    // 从列表进入：走 base 首页（cookie 已种，自动放行），不用 entryUrl（令牌一次性）
    router.pushUrl({
      url: 'pages/WebPage',
      params: { base: this.base, url: PairLogic.buildEnterUrl(this.base) },
    });
  }

  /** 删除前弹确认框，确认后才真正删除。 */
  confirmRemove(): void {
    AlertDialog.show({
      title: '删除配对',
      message: `确定删除 ${this.name !== '' ? this.name : this.base} 吗？`,
      primaryButton: {
        value: '取消',
        action: () => { /* 不删 */ }
      },
      secondaryButton: {
        value: '删除',
        fontColor: Theme.Err,
        action: () => {
          this.onRemove(this.base);
        }
      }
    });
  }
}

@Entry
@Component
struct Index {
  @State pairs: PairEntry[] = [];
  @State loaded: boolean = false;
  private store: PairStorageAdapter = new PairStorageAdapter();

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.store.init(ctx).then(() => {
      this.reload();
    }).catch(() => {
      this.reload();
    });
    const deep = AppStorage.get<string>('pairDeepLink') ?? '';
    if (deep) {
      this.handleDeepLink(deep);
      AppStorage.setOrCreate<string>('pairDeepLink', '');
    }
  }

  // 每次回到本页（从 WebPage / AddPair 返回）都强制从磁盘重读列表——
  // AddPair 是独立页面，它写入的配对在 Index 的存储适配器缓存的 mem 里
  // 看不到，必须重新读 preferences（否则列表空、要重启才出现）。
  onPageShow(): void {
    void this.reloadFromDisk();
  }

  reload(): void {
    const st = createPairStore(this.store);
    this.pairs = st.list();
    this.loaded = true;
  }

  // 每次回到本页强制重新读 preferences——AddPair 是独立页面，它写入的配对
  // 在 Index 自己的 PairStorageAdapter.mem 里没有缓存，必须从磁盘重读。
  async reloadFromDisk(): Promise<void> {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const pref = await preferences.getPreferences(ctx, 'dsh-mobile');
      const raw = (pref.getSync('dsh-mobile-pairs', '[]') as string) || '[]';
      try {
        this.pairs = JSON.parse(raw) as PairEntry[];
      } catch {
        this.pairs = [];
      }
      this.loaded = true;
    } catch (e) {
      // 回退到缓存存储
      this.reload();
    }
  }

  handleDeepLink(url: string): void {
    const p = PairLogic.parsePairInput(url);
    if (p == null) return;
    this.addAndEnter(p, '扫码配对');
  }

  addAndEnter(p: PairInput, name: string): void {
    const st = createPairStore(this.store);
    st.add({ token: p.token, base: p.base, name: name, entryUrl: p.entryUrl });
    st.active(p.base);
    this.reload();
    this.enter(p.base);
  }

  enter(base: string): void {
    // 从列表进入：永远走 base 首页（http://base/），不用 entryUrl——
    // entryUrl 是配对链接（/pair?token=..），令牌一次性已用掉，重复访问必失败。
    // 配对成功的 cookie 已种在 ArkWeb 里，直接访问 / 即可（带 cookie 自动放行）。
    router.pushUrl({
      url: 'pages/WebPage',
      params: { base: base, url: PairLogic.buildEnterUrl(base) },
    });
  }

  remove(base: string): void {
    const st = createPairStore(this.store);
    st.remove(base);
    this.reload();
  }

  build() {
    Column() {
      // 顶部：标题 + 添加配对按钮（原型 .top）
      Row() {
        Text('DSH Mobile')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(Theme.Text)
          .layoutWeight(1)
        Button('添加配对')
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor(Theme.Accent)
          .borderRadius(9)
          .height(30)
          .onClick(() => this.enterAdd())
      }
      .width('100%')
      .margin({ bottom: Theme.Sp16 })

      // 配对列表
      if (this.pairs.length > 0) {
        List({ space: Theme.Sp12 }) {
          ForEach(this.pairs, (p: PairEntry) => {
            ListItem() {
              // onRemove 回调：删除走 PairCard 内的确认框，不在列表层直接删
              PairCard({ base: p.base, name: p.name ?? '', entryUrl: p.entryUrl ?? '', onRemove: (base: string) => this.remove(base) })
            }
          }, (p: PairEntry) => p.base)
        }
        .width('100%')
        .layoutWeight(1)
      } else {
        // 空状态（原型 .empty）
        Column() {
          Text('还没有配对？扫码或输入配对地址完成配对')
            .fontSize(12)
            .fontColor(Theme.Text2)
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ top: Theme.Sp24, bottom: Theme.Sp24 })
        .border({ width: 1, color: Theme.Line, style: BorderStyle.Dashed })
        .borderRadius(Theme.RadiusCard)
        .layoutWeight(1)
      }

      // 底部 footer（原型 .footer）
      Row() {
        Text('配对 = 一次性令牌 + 会话 Cookie')
          .fontSize(11)
          .fontColor(Theme.Text2)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .padding({ top: Theme.Sp8 })
      .border({ width: { top: 0.5 }, color: Theme.Line })
    }
    .padding({ left: Theme.Sp16, right: Theme.Sp16, top: Theme.Sp24, bottom: Theme.Sp16 })
    .backgroundColor(Theme.Bg)
    .width('100%')
    .height('100%')
    // 底部导航栏已隐藏（EntryAbility），这里兜底延伸安全区，消除残留白边
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }

  enterAdd(): void {
    router.pushUrl({ url: 'pages/AddPair' });
  }
}
