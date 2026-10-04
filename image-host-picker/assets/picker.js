/**
 * 图床选图器 · 面板
 * - TinyMCE 插件（imagehostpicker）：工具栏「图床」按钮（id: image_host_picker）
 * - 面板：目录树 + 当前目录图片网格 + 搜索，数据走插件服务端代理
 * - 完全自包含，不依赖任何主题资源
 */
(function ($) {
    'use strict';

    /** 惰性读取本地化配置：TinyMCE 可能在 wp_localize 输出前加载本文件 */
    function getCfg() {
        return window.ImageHostPickerCfg || {};
    }

    /* ---------- 工具 ---------- */

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function mdAlt(filename) {
        return String(filename || 'image').replace(/\.[^.]+$/, '');
    }

    /** 调插件代理；成功 resolve 数据，失败 reject 错误文案 */
    function api(op, params) {
        var conf = getCfg();
        var data = $.extend({
            action: 'image_host_picker',
            nonce: conf.nonce || '',
            op: op
        }, params || {});

        if (!conf.ajaxUrl) {
            return $.Deferred().reject('面板配置未加载，请刷新编辑页面后重试').promise();
        }

        return $.ajax({
            url: conf.ajaxUrl,
            method: 'GET',
            data: data,
            dataType: 'json'
        }).then(function (resp) {
            if (resp && resp.success) {
                return resp.data;
            }
            var msg = (resp && resp.data) ? resp.data : '图床代理返回异常';
            if (typeof msg === 'object' && msg.message) { msg = msg.message; }
            return $.Deferred().reject(msg).promise();
        }, function (xhr) {
            var msg = '图床代理请求失败（HTTP ' + (xhr.status || 0) + '）';
            if (xhr.status === 403 || xhr.responseText === '0' || xhr.responseText === '-1') {
                msg = '安全校验失败（nonce 无效），请刷新编辑页面后重试';
            } else if (xhr.responseJSON && xhr.responseJSON.data) {
                msg = typeof xhr.responseJSON.data === 'string'
                    ? xhr.responseJSON.data
                    : (xhr.responseJSON.data.message || msg);
            } else if (xhr.responseText) {
                msg += '：' + String(xhr.responseText).replace(/\s+/g, ' ').slice(0, 160);
            }
            return $.Deferred().reject(msg).promise();
        });
    }

    /** 归一化 /api/tree 返回：兼容数组 / {tree} / 单节点 */
    function normalizeTree(payload) {
        if (Array.isArray(payload)) { return payload; }
        if (payload && Array.isArray(payload.tree)) { return payload.tree; }
        if (payload && payload.children) { return [payload]; }
        if (payload && payload.name !== undefined) { return [payload]; }
        return [];
    }

    /* ---------- 面板 ---------- */

    var panel = null;

    function getPanel() {
        if (panel) { return panel; }

        var $el = $(
            '<div class="ihp-overlay" style="display:none">' +
            '  <div class="ihp-panel" role="dialog" aria-label="图床选图">' +
            '    <div class="ihp-header">' +
            '      <strong>图床选图</strong>' +
            '      <span class="ihp-status"></span>' +
            '      <button type="button" class="ihp-close" aria-label="关闭">×</button>' +
            '    </div>' +
            '    <div class="ihp-toolbar">' +
            '      <input type="search" class="ihp-search" placeholder="搜索图片，回车确认" />' +
            '      <button type="button" class="button ihp-search-btn">搜索</button>' +
            '      <button type="button" class="button ihp-reset-btn">返回目录</button>' +
            '    </div>' +
            '    <div class="ihp-error" style="display:none"></div>' +
            '    <div class="ihp-body">' +
            '      <div class="ihp-tree"><div class="ihp-tree-loading">目录加载中…</div></div>' +
            '      <div class="ihp-main">' +
            '        <div class="ihp-path">/</div>' +
            '        <div class="ihp-grid"><div class="ihp-grid-loading">加载中…</div></div>' +
            '      </div>' +
            '    </div>' +
            '    <div class="ihp-footer">' +
            '      <span class="ihp-hint">单击选中，双击直接插入；插入位置为编辑器光标处</span>' +
            '      <span class="ihp-selected"></span>' +
            '      <span class="ihp-actions">' +
            '        <button type="button" class="button button-primary ihp-insert" disabled>插入图片</button>' +
            '        <button type="button" class="button ihp-copy" disabled>复制 Markdown</button>' +
            '      </span>' +
            '    </div>' +
            '  </div>' +
            '</div>'
        );

        $('body').append($el);

        panel = {
            $el: $el,
            $error: $el.find('.ihp-error'),
            $status: $el.find('.ihp-status'),
            $tree: $el.find('.ihp-tree'),
            $grid: $el.find('.ihp-grid'),
            $path: $el.find('.ihp-path'),
            $selected: $el.find('.ihp-selected'),
            $insert: $el.find('.ihp-insert'),
            $copy: $el.find('.ihp-copy'),
            $search: $el.find('.ihp-search'),
            editor: null,
            currentPath: '/',
            selected: null,
            treeLoaded: false
        };

        $el.find('.ihp-close').on('click', close);
        $el.on('click', function (e) {
            if (e.target === this) { close(); }
        });
        $(document).on('keydown.ihp', function (e) {
            if (e.key === 'Escape' && $el.is(':visible')) { close(); }
        });

        $el.find('.ihp-search-btn').on('click', doSearch);
        $el.find('.ihp-reset-btn').on('click', function () {
            panel.$search.val('');
            loadItems(panel.currentPath);
        });
        panel.$search.on('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        });

        panel.$insert.on('click', insertSelected);
        panel.$copy.on('click', copyMarkdown);

        return panel;
    }

    function showError(msg, retry) {
        var $err = panel.$error;
        $err.empty().append($('<span/>').text(msg));
        if (retry) {
            $err.append($('<button type="button" class="button">重试</button>').on('click', retry));
        }
        $err.show();
    }

    function hideError() {
        panel.$error.hide().empty();
    }

    function setStatus(text) {
        panel.$status.text(text || '');
    }

    function clearSelected() {
        panel.selected = null;
        panel.$selected.text('');
        panel.$insert.prop('disabled', true);
        panel.$copy.prop('disabled', true);
        panel.$grid.find('.ihp-tile-selected').removeClass('ihp-tile-selected');
    }

    function selectImage(url, filename, $tile) {
        panel.selected = { url: url, filename: filename };
        panel.$grid.find('.ihp-tile-selected').removeClass('ihp-tile-selected');
        if ($tile) { $tile.addClass('ihp-tile-selected'); }
        panel.$selected.text('已选中：' + filename);
        panel.$insert.prop('disabled', false);
        panel.$copy.prop('disabled', false);
    }

    /* ---------- 目录树 ---------- */

    function renderTreeNodes(nodes, $ul) {
        $.each(nodes, function (_, node) {
            if (!node) { return; }
            var path = node.path || '/' + (node.name || '');
            var name = node.name || path;
            var count = (node.imageCount !== undefined && node.imageCount !== null) ? node.imageCount : '';
            var $li = $('<li/>');
            var $row = $('<div class="ihp-tree-row"/>')
                .append($('<span class="ihp-tree-name"/>').text(name))
                .append($('<span class="ihp-tree-count"/>').text(count === '' ? '' : count + ' 张'));
            $row.on('click', function () {
                panel.$tree.find('.ihp-tree-active').removeClass('ihp-tree-active');
                $row.addClass('ihp-tree-active');
                loadItems(path);
            });
            $li.append($row);

            if (node.children && node.children.length) {
                var $child = $('<ul/>');
                renderTreeNodes(node.children, $child);
                $li.append($child);
            }
            $ul.append($li);
        });
    }

    function loadTree() {
        hideError();
        panel.$tree.html('<div class="ihp-tree-loading">目录加载中…</div>');

        return api('tree').then(function (data) {
            var roots = normalizeTree(data);
            // 图床返回的单根节点（path=/ 即「全部图片」）→ 只渲染其子节点，根行由面板自带
            if (roots.length === 1 && roots[0] && roots[0].path === '/') {
                roots = roots[0].children || [];
            }
            var $ul = $('<ul class="ihp-tree-root"/>');

            var $rootRow = $('<div class="ihp-tree-row ihp-tree-active"/>')
                .append($('<span class="ihp-tree-name"/>').text('全部图片'));
            $rootRow.on('click', function () {
                panel.$tree.find('.ihp-tree-active').removeClass('ihp-tree-active');
                $rootRow.addClass('ihp-tree-active');
                loadItems('/');
            });
            $ul.append($('<li/>').append($rootRow));

            renderTreeNodes(roots, $ul);
            panel.$tree.empty().append($ul);
            panel.treeLoaded = true;
        }, function (msg) {
            panel.$tree.html('<div class="ihp-tree-loading">目录不可用</div>');
            showError(msg, loadTree);
            return $.Deferred().reject(msg).promise();
        });
    }

    /* ---------- 图片网格 ---------- */

    function tileFolder(name, path) {
        var $t = $('<div class="ihp-tile ihp-tile-folder"/>')
            .append($('<div class="ihp-tile-thumb ihp-folder-icon"/>'))
            .append($('<div class="ihp-tile-name"/>').text(name));
        $t.on('click', function () { loadItems(path); });
        return $t;
    }

    function tileImage(img) {
        var url = img.url || '';
        var filename = img.filename || img.name || url.split('/').pop();
        var $t = $('<div class="ihp-tile" tabindex="0"/>')
            .append($('<div class="ihp-tile-thumb"/>').append(
                $('<img/>').attr('src', url).attr('alt', filename)
            ))
            .append($('<div class="ihp-tile-name"/>').attr('title', filename).text(filename));

        $t.on('click', function () { selectImage(url, filename, $t); });
        $t.on('dblclick', function () {
            selectImage(url, filename, $t);
            insertSelected();
        });
        return $t;
    }

    function renderGrid(folders, images, emptyText) {
        var $g = panel.$grid.empty();
        var has = false;

        $.each(folders || [], function (_, f) {
            if (!f) { return; }
            has = true;
            $g.append(tileFolder(f.name || f.path, f.path));
        });
        $.each(images || [], function (_, img) {
            if (!img || !img.url) { return; }
            has = true;
            $g.append(tileImage(img));
        });

        if (!has) {
            $g.append($('<div class="ihp-grid-empty"/>').text(emptyText || '该目录没有图片'));
        }
        clearSelected();
    }

    function loadItems(path) {
        hideError();
        setStatus('');
        panel.currentPath = path || '/';
        panel.$path.text(panel.currentPath);
        panel.$grid.html('<div class="ihp-grid-loading">加载中…</div>');

        return api('items', { path: panel.currentPath }).then(function (data) {
            data = data || {};
            renderGrid(data.folders, data.images);
        }, function (msg) {
            panel.$grid.empty();
            showError(msg, function () { loadItems(path); });
        });
    }

    function doSearch() {
        var q = $.trim(panel.$search.val());
        if (!q) {
            loadItems(panel.currentPath);
            return;
        }
        hideError();
        panel.$path.text('搜索：' + q);
        panel.$grid.html('<div class="ihp-grid-loading">搜索中…</div>');

        api('search', { q: q }).then(function (data) {
            data = data || {};
            renderGrid([], data.images, '没有找到与「' + q + '」匹配的图片');
        }, function (msg) {
            panel.$grid.empty();
            showError(msg, doSearch);
        });
    }

    /* ---------- 插入 / 复制 ---------- */

    function insertSelected() {
        if (!panel.selected || !panel.editor) { return; }
        var url = panel.selected.url;
        var alt = esc(mdAlt(panel.selected.filename));
        panel.editor.insertContent('<img src="' + esc(url) + '" alt="' + alt + '" />');
        setStatus('已插入 ' + panel.selected.filename);
    }

    function fallbackCopy(text) {
        var $ta = $('<textarea/>').css({ position: 'fixed', opacity: 0 }).val(text).appendTo('body');
        $ta[0].select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        $ta.remove();
    }

    function copyMarkdown() {
        if (!panel.selected) { return; }
        var md = '![' + mdAlt(panel.selected.filename) + '](' + panel.selected.url + ')';
        var done = function () { setStatus('Markdown 已复制'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(done, function () { fallbackCopy(md); done(); });
        } else {
            fallbackCopy(md);
            done();
        }
    }

    /* ---------- 打开 / 关闭 ---------- */

    function open(editor) {
        var p = getPanel();
        p.editor = editor;
        p.$el.show();
        hideError();
        setStatus('');
        if (!p.treeLoaded) {
            loadTree().then(function () { return loadItems('/'); });
        } else {
            loadItems(p.currentPath);
        }
        setTimeout(function () { p.$search.trigger('focus'); }, 50);
    }

    function close() {
        if (panel) { panel.$el.hide(); }
    }

    window.ImageHostPickerPanel = { open: open, close: close };

    /* ---------- TinyMCE 插件 ---------- */

    if (typeof tinymce !== 'undefined' && tinymce.PluginManager) {
        tinymce.PluginManager.add('imagehostpicker', function (editor) {
            editor.addButton('image_host_picker', {
                text: '图床',
                tooltip: '从图床选择图片插入',
                onclick: function () { open(editor); }
            });
            return {};
        });
    }
})(jQuery);
