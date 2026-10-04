<?php
/**
 * Plugin Name: 图床选图器
 * Plugin URI:  https://www.qingup.com
 * Description: 在经典编辑器（TinyMCE）工具栏添加「图床」按钮，从青枫图床浏览目录、搜索图片并插入直链。与青枫主题自带图床模块并存时自动让位，避免重复按钮。
 * Version:     1.0.0
 * Author:      青枫
 * Text Domain: image-host-picker
 * Requires PHP: 7.2
 *
 * @package image-host-picker
 */

defined('ABSPATH') || exit;

define('IMAGE_HOST_PICKER_VERSION', '1.0.0');
define('IMAGE_HOST_PICKER_DIR', plugin_dir_path(__FILE__));
define('IMAGE_HOST_PICKER_URL', plugin_dir_url(__FILE__));

/**
 * 读取插件设置
 *
 * @return array{base_url:string,api_token:string}
 */
function image_host_picker_settings()
{
    $saved = get_option('image_host_picker_settings', []);
    if (!is_array($saved)) {
        $saved = [];
    }

    $base_url = rtrim(trim(isset($saved['base_url']) ? (string) $saved['base_url'] : ''), '/');
    $api_token = trim(isset($saved['api_token']) ? (string) $saved['api_token'] : '');

    return [
        'base_url'  => $base_url,
        'api_token' => $api_token,
    ];
}

/**
 * 设置项清洗
 *
 * @param array $input 原始输入
 * @return array
 */
function image_host_picker_sanitize_settings($input)
{
    $input = is_array($input) ? $input : [];
    $base_url = isset($input['base_url']) ? trim((string) $input['base_url']) : '';
    $api_token = isset($input['api_token']) ? sanitize_text_field((string) $input['api_token']) : '';

    if ($base_url !== '' && !preg_match('#^https?://#i', $base_url)) {
        add_settings_error('image_host_picker_settings', 'image_host_picker_bad_url', '图床地址需以 http:// 或 https:// 开头，已清空');
        $base_url = '';
    } else {
        $base_url = esc_url_raw(rtrim($base_url, '/'));
    }

    return [
        'base_url'  => $base_url,
        'api_token' => $api_token,
    ];
}

/**
 * 防冲突：青枫主题自带图床模块时返回 true（插件让位）
 *
 * 判断依据为青枫主题 inc/qingfeng-image-host.php 中实际定义的函数：
 * - zhuige_image_host_proxy（admin-ajax 代理处理函数，模块存在的直接证据）
 * - zhuige_image_host_config / zhuige_image_host_mce_buttons（辅助兜底）
 */
function image_host_picker_theme_conflict()
{
    return function_exists('zhuige_image_host_proxy')
        || function_exists('zhuige_image_host_config')
        || function_exists('zhuige_image_host_mce_buttons');
}

/**
 * 编辑器功能是否启用（与青枫主题并存时抑制，设置页不受影响）
 */
function image_host_picker_editor_enabled()
{
    $suppressed = image_host_picker_theme_conflict();
    return !apply_filters('image_host_picker_suppress', $suppressed);
}

/**
 * 编辑屏标记（mce_external_plugins 过滤时无 hook 上下文）
 */
function image_host_picker_mark_edit_screen($hook = '')
{
    global $image_host_picker_edit_screen;
    $image_host_picker_edit_screen = in_array($hook, ['post.php', 'post-new.php'], true);
}
add_action('admin_enqueue_scripts', 'image_host_picker_mark_edit_screen', 1);

/**
 * 编辑器资源注入（仅编辑页、管理员、未被主题抑制时）
 */
function image_host_picker_admin_assets($hook)
{
    if (!in_array($hook, ['post.php', 'post-new.php'], true)) {
        return;
    }
    if (!current_user_can('manage_options') || !image_host_picker_editor_enabled()) {
        return;
    }

    wp_enqueue_style(
        'image-host-picker',
        IMAGE_HOST_PICKER_URL . 'assets/picker.css',
        [],
        IMAGE_HOST_PICKER_VERSION
    );

    wp_enqueue_script(
        'image-host-picker',
        IMAGE_HOST_PICKER_URL . 'assets/picker.js',
        ['jquery'],
        IMAGE_HOST_PICKER_VERSION,
        true
    );

    wp_localize_script('image-host-picker', 'ImageHostPickerCfg', [
        'ajaxUrl' => admin_url('admin-ajax.php'),
        'nonce'   => wp_create_nonce('image_host_picker'),
    ]);
}
add_action('admin_enqueue_scripts', 'image_host_picker_admin_assets');

/**
 * TinyMCE 工具栏第二行追加「图床」按钮
 */
function image_host_picker_mce_buttons($buttons)
{
    if (current_user_can('manage_options') && image_host_picker_editor_enabled()) {
        $buttons[] = 'image_host_picker';
    }
    return $buttons;
}
add_filter('mce_buttons_2', 'image_host_picker_mce_buttons');

/**
 * 注入 TinyMCE 插件
 */
function image_host_picker_mce_plugins($plugins)
{
    global $image_host_picker_edit_screen;
    if (!empty($image_host_picker_edit_screen)
        && current_user_can('manage_options')
        && image_host_picker_editor_enabled()) {
        $plugins['imagehostpicker'] = IMAGE_HOST_PICKER_URL . 'assets/picker.js';
    }
    return $plugins;
}
add_filter('mce_external_plugins', 'image_host_picker_mce_plugins');

/**
 * 图床接口代理（管理员 + nonce，Bearer 转发，中文错误提示）
 *
 * 参数：op=tree|items|search，items 带 path，search 带 q
 */
function image_host_picker_proxy()
{
    check_ajax_referer('image_host_picker', 'nonce');

    if (!current_user_can('manage_options')) {
        wp_send_json_error('无权限访问');
    }

    $settings = image_host_picker_settings();
    $base_url = $settings['base_url'];
    $token = $settings['api_token'];

    if ($base_url === '' || $token === '') {
        wp_send_json_error('图床未配置：请在「设置 → 图床选图器」填写图床地址和只读 Token');
    }
    if (!preg_match('#^https?://#i', $base_url)) {
        wp_send_json_error('图床地址格式错误：需以 http:// 或 https:// 开头');
    }

    $op = isset($_GET['op']) ? sanitize_key(wp_unslash($_GET['op'])) : '';
    switch ($op) {
        case 'tree':
            $url = $base_url . '/api/tree';
            break;
        case 'items':
            $path = isset($_GET['path']) ? wp_unslash($_GET['path']) : '';
            $path = is_string($path) ? trim($path) : '';
            if ($path === '' || $path[0] !== '/') {
                wp_send_json_error('目录参数错误');
            }
            $url = $base_url . '/api/items?path=' . rawurlencode($path);
            break;
        case 'search':
            $q = isset($_GET['q']) ? wp_unslash($_GET['q']) : '';
            $q = is_string($q) ? trim($q) : '';
            if ($q === '') {
                wp_send_json_error('请输入搜索关键词');
            }
            $url = $base_url . '/api/images/search?q=' . rawurlencode($q);
            break;
        default:
            wp_send_json_error('未知操作');
    }

    $response = wp_remote_get($url, [
        'timeout' => 12,
        'headers' => [
            'Authorization' => 'Bearer ' . $token,
            'Accept'        => 'application/json',
        ],
    ]);

    if (is_wp_error($response)) {
        wp_send_json_error('图床连接失败：' . $response->get_error_message());
    }

    $status = (int) wp_remote_retrieve_response_code($response);
    $body = wp_remote_retrieve_body($response);
    $payload = json_decode($body, true);

    if ($status === 401 || $status === 403) {
        wp_send_json_error('图床鉴权失败（HTTP ' . $status . '）：请检查只读 Token 是否正确');
    }
    if ($status === 404) {
        wp_send_json_error('图床接口不存在（HTTP 404）：请检查图床地址是否正确、图床是否支持 Token 调用');
    }
    if ($status < 200 || $status >= 300) {
        $snippet = is_string($body) ? mb_substr(trim($body), 0, 200) : '';
        wp_send_json_error('图床返回错误（HTTP ' . $status . '）' . ($snippet ? '：' . $snippet : ''));
    }
    if (!is_array($payload)) {
        wp_send_json_error('图床返回了无法解析的数据，请确认图床地址指向青枫图床服务');
    }

    wp_send_json_success($payload);
}
add_action('wp_ajax_image_host_picker', 'image_host_picker_proxy');

/**
 * 设置页：设置 → 图床选图器
 */
function image_host_picker_add_settings_page()
{
    add_options_page(
        '图床选图器',
        '图床选图器',
        'manage_options',
        'image-host-picker',
        'image_host_picker_render_settings_page'
    );
}
add_action('admin_menu', 'image_host_picker_add_settings_page');

function image_host_picker_register_settings()
{
    register_setting(
        'image_host_picker_settings_group',
        'image_host_picker_settings',
        ['sanitize_callback' => 'image_host_picker_sanitize_settings']
    );
}
add_action('admin_init', 'image_host_picker_register_settings');

function image_host_picker_render_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $settings = image_host_picker_settings();
    ?>
    <div class="wrap">
        <h1>图床选图器</h1>

        <?php if (image_host_picker_theme_conflict()) : ?>
            <div class="notice notice-warning">
                <p>检测到青枫主题自带的图床模块（<code>zhuige_image_host_proxy()</code>），本插件的编辑器按钮与资源已自动停用，避免同一站点出现两个「图床」按钮。此处的设置在切换到其他主题后自动生效。</p>
            </div>
        <?php endif; ?>

        <form method="post" action="options.php">
            <?php settings_fields('image_host_picker_settings_group'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="ihp_base_url">图床地址</label></th>
                    <td>
                        <input type="url" class="regular-text" id="ihp_base_url"
                               name="image_host_picker_settings[base_url]"
                               placeholder="https://img.example.com"
                               value="<?php echo esc_attr($settings['base_url']); ?>" />
                        <p class="description">青枫图床的访问根地址，不要以 / 结尾。容器/内网部署填容器可达的地址。</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="ihp_api_token">图床只读 Token</label></th>
                    <td>
                        <input type="text" class="regular-text" id="ihp_api_token"
                               name="image_host_picker_settings[api_token]"
                               placeholder="API_TOKEN"
                               value="<?php echo esc_attr($settings['api_token']); ?>" />
                        <p class="description">图床 .env 中的 API_TOKEN（只读权限）。仅在服务端代理转发时使用，不会下发到浏览器。</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2>使用方法</h2>
        <p>文章/页面编辑页（经典编辑器）工具栏第二行有「图床」按钮：左侧目录树、搜索框浏览图床图片，单击选中后「插入图片」在光标处插入直链，或「复制 Markdown」。数据经本站服务端代理转发，图床无需开放 CORS。</p>
    </div>
    <?php
}
