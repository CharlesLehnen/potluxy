// style.js
$(document).ready(function () {
  // one selector to rule them all
  const focusableSelector =
    'input[type="text"], input[type="password"], input[type="date"], input[type="time"], textarea';

  // actually grab them
  const $focusables = $(focusableSelector);

  // Input focus/blur effects
  $focusables.on('focus', function () {
    $('#formWrapper').addClass('darken-bg');
    $('#google_translate_element').css({
      'background-color': 'rgb(117, 112, 112)',
      'border-radius': '0',
      'width': '100vw'
    });
    $('h1').css('color', '#44aacc');
  });

  // handle blur, but only remove the darkening if NOTHING is focused anymore
  $(document).on('blur', focusableSelector, function () {
    // check if any matching input is still focused (e.g. user tabbed to the next one)
    const stillFocused = $(focusableSelector).is(':focus');
    if (stillFocused) return;

    $('#formWrapper').removeClass('darken-bg');
    $('#google_translate_element').css({
      'background-color': 'rgba(255, 255, 255, 0.9)',
      'border-radius': '0',
      'width': '100vw'
    });
    $('h1').css('color', '#2c3e50');
  });

  // Tab switching logic
  $('.tab-button').on('click', function () {
    const targetTab = $(this).data('tab');

    $('.tab-button').removeClass('active');
    $(this).addClass('active');

    $('.tab-content').removeClass('active');
    $(`#tab-${targetTab}`).addClass('active');
  });
});
