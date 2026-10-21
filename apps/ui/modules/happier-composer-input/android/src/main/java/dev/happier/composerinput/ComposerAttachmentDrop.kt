package dev.happier.composerinput

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import android.webkit.MimeTypeMap
import java.io.File
import java.io.IOException
import java.util.UUID

/** Read OS grants before release; upload/destination/tree policy stays in the attachment owner. */
internal object ComposerAttachmentDrop {
  fun read(context: Context, original: Uri): Map<String, Any> {
    val resolver = context.contentResolver
    val cache = File(context.cacheDir, "DocumentPicker/${UUID.randomUUID()}")
    if (!cache.mkdirs()) throw IOException("Attachment cache unavailable")
    try {
      fun copy(uri: Uri, name: String): Map<String, Any> {
        val target = File(cache, UUID.randomUUID().toString())
        val input = if (uri.scheme == "file") File(requireNotNull(uri.path)).inputStream()
          else resolver.openInputStream(uri) ?: throw IOException("Attachment unavailable")
        input.use { source -> target.outputStream().use { source.copyTo(it) } }
        return mapOf("kind" to "native", "uri" to Uri.fromFile(target).toString(), "name" to name,
          "sizeBytes" to target.length(), "mimeType" to (resolver.getType(uri)
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"))
      }
      if (original.scheme == "file") {
        val root = File(requireNotNull(original.path))
        fun check(file: File) { if (OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)) throw IOException("Symbolic link refused") }
        check(root)
        if (!root.isDirectory) return copy(original, root.name)
        val entries = mutableListOf<Map<String, Any>>()
        val directories = mutableListOf<String>()
        fun visit(directory: File, relative: String) {
          val children = directory.listFiles() ?: throw IOException("Directory unavailable")
          for (child in children) {
            check(child)
            val path = if (relative.isEmpty()) child.name else "$relative/${child.name}"
            if (child.isDirectory) { directories.add(path); visit(child, path) }
            else entries.add(mapOf("relativePath" to path, "source" to copy(Uri.fromFile(child), child.name)))
          }
        }
        visit(root, "")
        return mapOf("kind" to "folder", "name" to root.name, "mimeType" to "inode/directory", "entries" to entries, "directories" to directories)
      }
      if (original.scheme != "content") throw IOException("Unsupported attachment URI")
      val tree = DocumentsContract.isTreeUri(original)
      val uri = if (tree && !DocumentsContract.isDocumentUri(context, original))
        DocumentsContract.buildDocumentUriUsingTree(original, DocumentsContract.getTreeDocumentId(original)) else original
      fun name(uri: Uri): String {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) return cursor.getString(0)
        }
        throw IOException("Attachment name unavailable")
      }
      val rootName = name(uri)
      if (resolver.getType(uri) != DocumentsContract.Document.MIME_TYPE_DIR) return copy(uri, rootName)
      val entries = mutableListOf<Map<String, Any>>()
      val directories = mutableListOf<String>()
      fun visit(directory: Uri, relative: String) {
        val id = DocumentsContract.getDocumentId(directory)
        val children = if (tree) DocumentsContract.buildChildDocumentsUriUsingTree(original, id)
          else DocumentsContract.buildChildDocumentsUri(requireNotNull(directory.authority), id)
        val cursor = resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)
          ?: throw IOException("Directory unavailable")
        cursor.use {
          while (it.moveToNext()) {
            val childId = it.getString(0)
            val childName = it.getString(1)
            val child = if (tree) DocumentsContract.buildDocumentUriUsingTree(original, childId)
              else DocumentsContract.buildDocumentUri(requireNotNull(directory.authority), childId)
            val path = if (relative.isEmpty()) childName else "$relative/$childName"
            if (it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) { directories.add(path); visit(child, path) }
            else entries.add(mapOf("relativePath" to path, "source" to copy(child, childName)))
          }
        }
      }
      visit(uri, "")
      return mapOf("kind" to "folder", "name" to rootName, "mimeType" to "inode/directory", "entries" to entries, "directories" to directories)
    } catch (error: Exception) {
      cache.deleteRecursively()
      throw error
    }
  }
}
