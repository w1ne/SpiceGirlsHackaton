package com.spicegirls.dispenser;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioModePlugin.class); // voice-call audio mode for realtime AEC
        super.onCreate(savedInstanceState);
        // Grant the WebView's getUserMedia (mic) request so WebRTC realtime voice
        // works. OS-level RECORD_AUDIO is requested separately by the app.
        getBridge().getWebView().setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
