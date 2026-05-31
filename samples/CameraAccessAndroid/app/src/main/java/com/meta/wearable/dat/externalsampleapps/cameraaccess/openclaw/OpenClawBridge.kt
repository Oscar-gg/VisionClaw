package com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw

import android.util.Log
import com.meta.wearable.dat.externalsampleapps.cameraaccess.gemini.GeminiConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class OpenClawBridge {
    companion object {
        private const val TAG = "ClaudeBridge"
    }

    private val _lastToolCallStatus = MutableStateFlow<ToolCallStatus>(ToolCallStatus.Idle)
    val lastToolCallStatus: StateFlow<ToolCallStatus> = _lastToolCallStatus.asStateFlow()

    private val _connectionState = MutableStateFlow<AgentConnectionState>(AgentConnectionState.NotConfigured)
    val connectionState: StateFlow<AgentConnectionState> = _connectionState.asStateFlow()

    // Persisted conversation ID — reused so Claude retains context across tool calls
    private var conversationId: String? = null

    fun setToolCallStatus(status: ToolCallStatus) {
        _lastToolCallStatus.value = status
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private val pingClient = OkHttpClient.Builder()
        .readTimeout(5, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()

    private fun baseUrl() = "${GeminiConfig.claudeCodeHost}:${GeminiConfig.claudeCodePort}"

    suspend fun checkConnection() = withContext(Dispatchers.IO) {
        if (!GeminiConfig.isClaudeCodeConfigured) {
            _connectionState.value = AgentConnectionState.NotConfigured
            return@withContext
        }
        _connectionState.value = AgentConnectionState.Checking

        try {
            val request = Request.Builder()
                .url("${baseUrl()}/health")
                .get()
                .addHeader("Authorization", "Bearer ${GeminiConfig.claudeCodeToken}")
                .build()

            val response = pingClient.newCall(request).execute()
            val code = response.code
            response.close()

            if (code in 200..299) {
                _connectionState.value = AgentConnectionState.Connected
                Log.d(TAG, "Bridge reachable (HTTP $code)")
            } else {
                _connectionState.value = AgentConnectionState.Unreachable("HTTP $code — is the new server running? (needs npm run dev)")
                Log.w(TAG, "Bridge returned unexpected status: $code")
            }
        } catch (e: Exception) {
            _connectionState.value = AgentConnectionState.Unreachable(e.message ?: "Unknown error")
            Log.d(TAG, "Bridge unreachable: ${e.message}")
        }
    }

    suspend fun resetSession() = withContext(Dispatchers.IO) {
        if (!GeminiConfig.isClaudeCodeConfigured) return@withContext
        try {
            val body = JSONObject().apply {
                conversationId?.let { put("conversation_id", it) }
            }
            val request = Request.Builder()
                .url("${baseUrl()}/reset")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer ${GeminiConfig.claudeCodeToken}")
                .build()
            pingClient.newCall(request).execute().close()
            conversationId = null
            Log.d(TAG, "Session reset")
        } catch (e: Exception) {
            Log.d(TAG, "Reset failed (non-fatal): ${e.message}")
        }
    }

    /**
     * Send a message to Claude with optional image frames.
     * Maintains conversation history via a persistent conversation_id.
     *
     * @param text The user's message / task description
     * @param images Optional list of base64-encoded JPEG frames from the glasses camera
     * @param toolName Used only for status reporting in the UI
     */
    suspend fun chat(
        text: String,
        images: List<String> = emptyList(),
        toolName: String = "execute"
    ): ToolResult = withContext(Dispatchers.IO) {
        _lastToolCallStatus.value = ToolCallStatus.Executing(toolName)

        try {
            val url = "${baseUrl()}/chat"
            Log.d(TAG, "POST $url | text=${text.take(80)} | images=${images.size} | convId=$conversationId")

            val body = JSONObject().apply {
                put("text", text)
                conversationId?.let { put("conversation_id", it) }
                if (images.isNotEmpty()) {
                    put("images", JSONArray().apply { images.forEach { put(it) } })
                }
            }

            val request = Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer ${GeminiConfig.claudeCodeToken}")
                .addHeader("Content-Type", "application/json")
                .build()

            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""
            val statusCode = response.code
            response.close()

            Log.d(TAG, "HTTP $statusCode | body=${responseBody.take(200)}")

            if (statusCode !in 200..299) {
                Log.e(TAG, "Chat failed: HTTP $statusCode - ${responseBody.take(400)}")
                _lastToolCallStatus.value = ToolCallStatus.Failed(toolName, "HTTP $statusCode")
                return@withContext ToolResult.Failure("Claude returned HTTP $statusCode")
            }

            val json = JSONObject(responseBody)

            // Persist conversation ID for context continuity
            val newConversationId = json.optString("conversation_id", "")
            if (newConversationId.isNotEmpty()) {
                conversationId = newConversationId
            }

            val resultText = json.optString("text", "")
            val error = json.optString("error", "")

            if (error.isNotEmpty()) {
                Log.d(TAG, "Chat error: $error")
                _lastToolCallStatus.value = ToolCallStatus.Failed(toolName, error)
                return@withContext ToolResult.Failure(error)
            }

            Log.d(TAG, "Chat result: ${resultText.take(200)}")
            _lastToolCallStatus.value = ToolCallStatus.Completed(toolName)
            return@withContext ToolResult.Success(resultText)
        } catch (e: Exception) {
            Log.e(TAG, "Chat exception: ${e.message}")
            _lastToolCallStatus.value = ToolCallStatus.Failed(toolName, e.message ?: "Unknown")
            return@withContext ToolResult.Failure("Bridge error: ${e.message}")
        }
    }
}
