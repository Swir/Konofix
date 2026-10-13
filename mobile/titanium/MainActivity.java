package info.swirtv.konofix.androidtest;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** SDK-compiled host. Contains no JavaScript-to-native privileged bridge. */
public final class MainActivity extends Activity {
    private WebView web;
    private FrameLayout root;
    private boolean ready;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(0xff101522);
        getWindow().setNavigationBarColor(0xff101522);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xff101522);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        try {
            web = new WebView(this);
            web.setBackgroundColor(0xff101522);
            web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
            WebView.setWebContentsDebuggingEnabled(false);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setSafeBrowsingEnabled(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setGeolocationEnabled(false);
            web.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return external(request.getUrl());
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    return external(Uri.parse(url));
                }
                @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    root.removeView(view); view.destroy(); web = null;
                    showFailure("Proces Android System WebView został zatrzymany. Otwórz aplikację ponownie.");
                    Log.e("KonofixAndroid", "KONOFIX_RENDERER_GONE");
                    return true;
                }
                @Override public void onPageFinished(WebView view, String url) {
                    view.postDelayed(() -> {
                        if (!ready && web != null) Log.e("KonofixAndroid", "KONOFIX_UI_TIMEOUT");
                    }, 15000);
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onConsoleMessage(ConsoleMessage message) {
                    // Never log chat contents, nicknames or identity secrets.
                    if ("KONOFIX_UI_READY".equals(message.message())) {
                        ready = true;
                        Log.i("KonofixAndroid", "KONOFIX_UI_READY");
                    } else if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                        Log.e("KonofixAndroid", "KONOFIX_WEB_ERROR line=" + message.lineNumber());
                    }
                    return true;
                }
            });
            root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            String html;
            try (InputStream input = getAssets().open("www/index.html"); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                byte[] data = new byte[8192]; int count;
                while ((count = input.read(data)) != -1) {
                    buffer.write(data, 0, count);
                    if (buffer.size() > 4 * 1024 * 1024) throw new IllegalStateException("Bundled interface too large");
                }
                html = buffer.toString("UTF-8");
            }
            // All HTML/CSS/JS is bundled; HTTPS base grants a secure WebCrypto origin.
            // This URL is not fetched from the internet.
            web.loadDataWithBaseURL("https://konofix.local/", html, "text/html", "UTF-8", null);
        } catch (Exception failure) {
            if (web != null) { root.removeView(web); web.destroy(); web = null; }
            showFailure("Nie udało się uruchomić interfejsu. Sprawdź aktualizację Android System WebView i otwórz Konofix ponownie.");
            Log.e("KonofixAndroid", "KONOFIX_NATIVE_START_FAILED", failure);
        }
    }
    private boolean external(Uri uri) {
        if ("https".equals(uri.getScheme()) && "github.com".equals(uri.getHost())) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
        }
        // No untrusted documents may navigate the privileged local application origin.
        return true;
    }
    private void showFailure(String text) {
        TextView label = new TextView(this); label.setText(text); label.setTextColor(0xffdfe8f7);
        label.setTextSize(17); label.setPadding(32, 48, 32, 32); root.addView(label);
    }
    private void javascript(String method) {
        if (web != null) web.evaluateJavascript("window.KonoMobile&&window.KonoMobile." + method + "()", null);
    }
    @Override protected void onPause() { javascript("pause"); super.onPause(); }
    @Override protected void onResume() { super.onResume(); javascript("resume"); }
    @Override public void onBackPressed() { javascript("back"); }
    @Override protected void onDestroy() {
        if (web != null) { root.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
