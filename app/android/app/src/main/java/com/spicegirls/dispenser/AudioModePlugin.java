package com.spicegirls.dispenser;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Puts the device's audio session into voice-call mode for the realtime voice
 * session — MODE_IN_COMMUNICATION engages the platform's hardware echo
 * canceller (AEC) tuned for speakerphone, exactly what native voice apps
 * (ChatGPT, phone calls) use. Without it the WebView's WebRTC playback runs as
 * plain media and the software AEC can't keep the bot's own speaker voice out
 * of the open mic — it interrupts itself and acts on phantom turns.
 */
@CapacitorPlugin(name = "AudioMode")
public class AudioModePlugin extends Plugin {

    @PluginMethod
    public void setInCall(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        if (on) {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            setSpeaker(am, true); // keep the loudspeaker — in-call mode defaults to earpiece
        } else {
            setSpeaker(am, false);
            am.setMode(AudioManager.MODE_NORMAL);
        }
        call.resolve();
    }

    private void setSpeaker(AudioManager am, boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (on) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        am.setCommunicationDevice(d);
                        return;
                    }
                }
            } else {
                am.clearCommunicationDevice();
            }
        } else {
            am.setSpeakerphoneOn(on);
        }
    }
}
