import gc
import network

network.WLAN(network.STA_IF).active(False)
network.WLAN(network.AP_IF).active(False)

gc.collect()
