// macOS 通知桥（Old shell `desktop/src-tauri/src/network/notify_un.rs` 的等价物）。
//
// 为什么需要它：Electrobun 只暴露 `Utils.showNotification`，拿不到授权状态，也不能
// 主动申请权限；而 Bun 进程没有 run loop，自己用 FFI 手搓 block 调 UNUserNotificationCenter
// 的异步回调收不到（实测超时/崩溃）。所以照旧壳的路子：**在自己的进程里**用真 block 调 UN，
// 由本 dylib 起一条后台串行队列承接回调，把结果写进原子变量，JS 侧轮询取状态。
//
// 身份（bundle id）来自进程本身，所以：
//   · 打包 .app 里正常工作；
//   · 裸 bun 二进制（无 bundle）调 `currentNotificationCenter` 会直接崩 —— 调用方必须先确认
//     自己在 .app 里（旧壳同样是「仅打包 .app 可用」）。
//
// 线程模型：所有 UN 调用都丢到 `dsh.queue`（串行）上做，回调里只写原子量；
// 主线程（JS）只做无阻塞的读取，绝不阻塞事件循环。
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdatomic.h>
#include <string.h>
#include <stdlib.h>

// 状态码：0 未知/不可用，1 未决定，2 已拒绝，3 已授权
static atomic_int g_status = 0;
static atomic_int g_lastError = 0;
static atomic_int g_requested = 0;
static atomic_int g_started = 0;
static dispatch_queue_t g_queue = NULL;

/*
 * 进程身份门：UNUserNotificationCenter 需要进程持有 bundle id；裸二进制（CI、`bun run`、
 * 黑盒测试）没有它，在这一层调 UN 会让 Bun 直接 panic（实测：A C++ exception occurred）。
 * 旧壳 `notify_un.rs` 同样写明「仅打包 .app 可用」。返回 0 表示能用。
 */
static int missing_bundle_identity(void) {
	@autoreleasepool {
		return [NSBundle mainBundle].bundleIdentifier == nil ? 1 : 0;
	}
}

static int map_status(UNAuthorizationStatus status) {
	switch (status) {
		case UNAuthorizationStatusNotDetermined: return 1;
		case UNAuthorizationStatusDenied: return 2;
		case UNAuthorizationStatusAuthorized: return 3;
		case UNAuthorizationStatusProvisional: return 3;
		// Ephemeral 在 macOS 上不存在（仅 iOS），故不列
		default: return 0;
	}
}

/** 读一次授权状态（同步语义，但必须在后台队列上调用）。 */
static void refresh_status(void) {
	dispatch_semaphore_t sem = dispatch_semaphore_create(0);
	__block int mapped = 0;
	[[UNUserNotificationCenter currentNotificationCenter]
		getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
			mapped = map_status(settings.authorizationStatus);
			dispatch_semaphore_signal(sem);
		}];
	dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5ull * NSEC_PER_SEC));
	if (mapped != 0) atomic_store(&g_status, mapped);
}

/** 申请授权（options = alert|sound|badge）。仅第一次真正弹窗，之后由系统缓存决定。 */
static void request_auth(void) {
	dispatch_semaphore_t sem = dispatch_semaphore_create(0);
	__block BOOL granted = NO;
	[[UNUserNotificationCenter currentNotificationCenter]
		requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
		completionHandler:^(BOOL ok, NSError *error) {
			granted = ok;
			if (error != nil) atomic_store(&g_lastError, (int)error.code);
			dispatch_semaphore_signal(sem);
		}];
	dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 120ull * NSEC_PER_SEC));
	atomic_store(&g_status, granted ? 3 : 2);
	refresh_status();
}

static void ensure_queue(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		g_queue = dispatch_queue_create("com.arcreel.dsh-desktop-tauriapp.notify", DISPATCH_QUEUE_SERIAL);
	});
}

/** 幂等初始化：起后台队列并把授权状态刷一次；未决定就顺手申请（与旧壳 setup 阶段一致）。 */
void dsh_un_start(void) {
	// 裸进程没身份：绝不能碰 UN（会让 Bun 直接 panic），如实报不可用
	if (missing_bundle_identity()) { atomic_store(&g_lastError, -1); return; }
	ensure_queue();
	if (atomic_exchange(&g_started, 1) == 1) return;
	dispatch_async(g_queue, ^{
		refresh_status();
		if (atomic_load(&g_status) == 1) request_auth();
	});
}

/** 只读状态：0 未知，1 未决定，2 已拒绝，3 已授权。 */
int dsh_un_status(void) { return atomic_load(&g_status); }

/** 主动申请（设置 tab 的「申请权限」）：异步，弹窗结果由后续轮询看到。 */
void dsh_un_request(void) {
	if (missing_bundle_identity()) { atomic_store(&g_lastError, -1); return; }
	ensure_queue();
	atomic_store(&g_requested, 1);
	dispatch_async(g_queue, ^{ request_auth(); });
}

/** 上次错误码（诊断用；0 = 无）。 */
int dsh_un_last_error(void) { return atomic_load(&g_lastError); }

/** 投递一条通知（异步）。返回 1 表示已排进队列，0 表示参数不合法。 */
int dsh_un_post(const char *title, const char *body, int with_sound) {
	if (title == NULL) return 0;
	if (missing_bundle_identity()) { atomic_store(&g_lastError, -1); return 0; }
	ensure_queue();
	char *title_copy = strdup(title);
	char *body_copy = strdup(body == NULL ? "" : body);
	dispatch_async(g_queue, ^{
		UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
		content.title = [NSString stringWithUTF8String:title_copy];
		content.body = [NSString stringWithUTF8String:body_copy];
		if (with_sound) content.sound = [UNNotificationSound defaultSound];
		NSString *identifier = [NSString stringWithFormat:@"dsh-%lld", (long long)([[NSDate date] timeIntervalSince1970] * 1000)];
		UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
		dispatch_semaphore_t sem = dispatch_semaphore_create(0);
		[[UNUserNotificationCenter currentNotificationCenter]
			addNotificationRequest:request
			withCompletionHandler:^(NSError *error) {
				if (error != nil) atomic_store(&g_lastError, (int)error.code);
				dispatch_semaphore_signal(sem);
			}];
		dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10ull * NSEC_PER_SEC));
		free(title_copy);
		free(body_copy);
	});
	return 1;
}
