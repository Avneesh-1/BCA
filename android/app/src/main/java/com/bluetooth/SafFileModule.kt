package com.bluetooth

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.*
import java.io.OutputStream

class SafFileModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
    private var pendingPromise: Promise? = null
    private var pendingFileName: String? = null
    private var pendingBase64: String? = null

    override fun getName() = "SafFileModule"

    init {
        reactContext.addActivityEventListener(this)
    }

    @ReactMethod
    fun saveFileWithDialog(fileName: String, base64: String, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No current activity")
            return
        }
        pendingPromise = promise
        pendingFileName = fileName
        pendingBase64 = base64

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            putExtra(Intent.EXTRA_TITLE, fileName)
        }
        activity.startActivityForResult(intent, 2025)
    }

    // FIX: Correct method signatures for ActivityEventListener
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 2025 && pendingPromise != null) {
            val promise = pendingPromise
            pendingPromise = null
            if (resultCode == Activity.RESULT_OK && data != null) {
                val uri: Uri? = data.data
                if (uri != null && pendingBase64 != null) {
                    try {
                        val out: OutputStream? = activity.contentResolver.openOutputStream(uri)
                        val bytes = Base64.decode(pendingBase64, Base64.DEFAULT)
                        out?.write(bytes)
                        out?.close()
                        promise?.resolve(uri.toString())
                    } catch (e: Exception) {
                        promise?.reject("WRITE_ERROR", e.message)
                    }
                } else {
                    promise?.reject("NO_URI", "No URI returned")
                }
            } else {
                promise?.reject("CANCELLED", "User cancelled")
            }
            pendingFileName = null
            pendingBase64 = null
        }
    }

    override fun onNewIntent(intent: Intent) {
        // No implementation needed for this use case
    }
} 